import {
    isObject,
    equal,
    unknownOp
} from '../util'

import MISSING from './missing_symbol';
import Path from './path';
import Fields from './fields';

const isIndexMatchable = (value) => {
    if (typeof value === 'number') { return !isNaN(value); }
    if (typeof value === 'string') { return true; }
    if (typeof value === 'boolean') { return true; }
    if (!value) { return false; }
    if (value.constructor === Object) { return false; }

    if (Array.isArray(value)) {
        for (let element of value) {
            if (!isIndexMatchable(element)) {
                return false;
            }
        }

        return true;
    }

    if (value instanceof Date) {
        return !isNaN(value.valueOf());
    }

    return false;
};

export class Operator {
    is_index_matchable?: boolean
    getClauses() {
        return this.is_index_matchable ? [this] : [];
    }
}

export class Connective extends Operator {
    constructor(public args) {
        super();
    }
}

export class Conjunction extends Connective {
    getClauses() {
        const clauses: any[] = [];

        for (let i = 0; i < this.args.length; i++) {
            const op = this.args[i];

            if (op instanceof Connective) {
                clauses.push(...op.getClauses());
            } else if (op.is_index_matchable) {
                op.parent = this;
                op.index = i;

                clauses.push(op);
            }
        }

        return clauses;
    }

    run(fields: Fields) {
        for (let arg of this.args) {
            if (!arg.run(fields)) { return false; }
        }

        return true;
    }
}

export class Disjunction extends Connective {
    getClauses() { return []; }

    run(fields: Fields) {
        for (let arg of this.args) {
            if (arg.run(fields)) { return true; }
        }

        return false;
    }
}

class Negation extends Conjunction {
    getClauses() { return []; }

    run(fields: Fields) { return !super.run(fields); }
}

export class Exists extends Operator {
    constructor(public path, public bool) {
        super();
    }

    get is_index_matchable() { return !!this.bool; }

    run(fields: Fields) {
        return fields.get(this.path) !== MISSING === this.bool;
    }
}

class Equal extends Operator {
    constructor(public path, public value) {
        super();
    }

    get is_index_matchable() {
        return isIndexMatchable(this.value);
    }

    get idb_key_range() {
        return IDBKeyRange.only(this.value);
    }

    run(fields: Fields) {
        const value = fields.get(this.path);
        if (value === MISSING) { return false; }

        return equal(value, this.value);
    }
}

class NotEqual extends Equal {
    get is_index_matchable() { return false; }

    run(fields: Fields) { return !super.run(fields); }
}

class Range extends Operator {
    constructor(public path, public fns, public values) {
        super();
    }

    get is_index_matchable() { return true; }

    run(fields: Fields) {
        const value = fields.get(this.path);

        if (value === MISSING || value == null) {
            return false;
        }

        const { fns, values } = this;

        for (let i = 0; i < fns.length; i++) {
            if (!fns[i](value, values[i])) {
                return false;
            }
        }

        return true;
    }
}

const rangeMixin = (...fns) => {
    return class extends Range {
        constructor(path, values) { super(path, fns, values); }
    };
};

const gt = (a, b) => a > b,
    gte = (a, b) => a >= b,
    lt = (a, b) => a < b,
    lte = (a, b) => a <= b;

class Gt extends rangeMixin(gt) {
    get idb_key_range() {
        return IDBKeyRange.lowerBound(this.values[0], this.values[1] || true);
    }
}

class Gte extends rangeMixin(gte) {
    get idb_key_range() {
        return IDBKeyRange.lowerBound(this.values[0], this.values[1]);
    }
}

class Lt extends rangeMixin(lt) {
    get idb_key_range() {
        return IDBKeyRange.upperBound(this.values[0], this.values[1]
            || true);
    }
}

class Lte extends rangeMixin(lte) {
    get idb_key_range() {
        return IDBKeyRange.upperBound(this.values[0], this.values[1]);
    }
}

class GtLt extends rangeMixin(gt, lt) {
    get idb_key_range() {
        return IDBKeyRange.bound(this.values[0], this.values[1]
            || true, true);
    }
}

class GteLt extends rangeMixin(gte, lt) {
    get idb_key_range() {
        return IDBKeyRange.bound(this.values[0], this.values[1]
            || false, true);
    }
}

class GtLte extends rangeMixin(gt, lte) {
    get idb_key_range() {
        return IDBKeyRange.bound(this.values[0], this.values[1]
            || true, false);
    }
}

class GteLte extends rangeMixin(gte, lte) {
    get idb_key_range() {
        return IDBKeyRange.bound(this.values[0], this.values[1]);
    }
}

class ElemMatch extends Operator {
    constructor(public path: string, public op: Conjunction) {
        super();
    }

    get is_index_matchable() { return false; }

    run(fields: Fields) {
        const elements = fields.get(this.path);

        if (!elements || !elements[Symbol.iterator]) {
            return false;
        }

        const { op } = this;

        for (let obj of elements) {
            if (isObject(obj) && op.run(new Fields(obj))) {
                return true;
            }
        }

        return false;
    }
}

class RegEx extends Operator {
    constructor(public path, public expr) {
        super();
    }

    get is_index_matchable() { return false; }

    run(fields: Fields) {
        const value = fields.get(this.path);
        if (value === MISSING) { return false; }

        return this.expr.test(value);
    }
}

const $and = (parent_args, args) => {
    for (let expr of args) {
        const arg = build(expr);

        if (arg === false) { return false; }
        if (!arg) { continue; }

        if (arg.constructor === Conjunction) {
            parent_args.push(...arg.args);
        } else { parent_args.push(arg); }
    }

    return true;
};

const $or = (parent_args, args) => {
    const new_args: any[] = [];

    let has_false;

    for (let expr of args) {
        const arg = build(expr);

        if (!arg) {
            if (arg === false) { has_false = true; }

            continue;
        }

        if (arg.constructor === Disjunction) {
            new_args.push(...arg.args);
        } else { new_args.push(arg); }
    }

    if (new_args.length > 1) {
        parent_args.push(new Disjunction(new_args));
    } else if (new_args.length) {
        parent_args.push(new_args[0]);
    } else if (has_false) { return false; }

    return true;
};

const $not = (parent_args, args) => {
    const new_args: any[] = [];

    for (let expr of args) {
        const arg = build(expr);

        if (arg) { new_args.push(arg); }
    }

    if (new_args.length) {
        parent_args.push(new Negation(new_args));
    }

    return true;
};

const connectives = {
    $and,
    $or,
    $not,
    $nor: $not
};

const ranges = [
    [GtLt, '$gt', '$lt'],
    [GteLt, '$gte', '$lt'],
    [GtLte, '$gt', '$lte'],
    [GteLte, '$gte', '$lte'],
    [Gt, '$gt'],
    [Gte, '$gte'],
    [Lt, '$lt'],
    [Lte, '$lte']
];

const buildRange = (new_args, path, params, op_keys) => {
    const build = (RangeOp, range_keys) => {
        const values: any[] = [];

        for (let name of range_keys) {
            if (!op_keys.has(name)) { return; }

            const value = params[name];
            if (!isIndexMatchable(value)) { return false; }

            values.push(value);
        }

        new_args.push(new RangeOp(path, values));

        return true;
    };

    for (let [RangeOp, ...range_keys] of ranges) {
        const result = build(RangeOp, range_keys);

        if (result === false) { return; }
        if (!result) { continue; }

        op_keys.delete('$gt');
        op_keys.delete('$gte');
        op_keys.delete('$lt');
        op_keys.delete('$lte');

        break;
    }

    return true;
};

const buildClause = (parent_args, path, params) => {
    const withoutOps = () => {
        parent_args.push(new Equal(path, params));

        return true;
    };

    if (params == null || params.constructor !== Object) {
        return withoutOps();
    }

    const op_keys = new Set(Object.keys(params));

    if (op_keys.has('$exists') && !params.$exists) {
        parent_args.push(new Exists(path, false));

        return true;
    }

    const new_args: any[] = [];

    if (op_keys.has('$eq')) {
        new_args.push(new Equal(path, params.$eq));

        op_keys.delete('$eq');
    }

    if (op_keys.has('$ne')) {
        new_args.push(new NotEqual(path, params.$ne));

        op_keys.delete('$ne');
    }

    if (!buildRange(new_args, path, params, op_keys)) {
        return false;
    }

    if (op_keys.has('$in')) {
        const eqs: any[] = [];

        for (let value of params.$in) {
            eqs.push(new Equal(path, value));
        }

        if (eqs.length > 1) {
            new_args.push(new Disjunction(eqs));
        } else if (eqs.length) { new_args.push(eqs[0]); }

        op_keys.delete('$in');
    }

    if (op_keys.has('$nin')) {
        for (let value of params.$nin) {
            new_args.push(new NotEqual(path, value));
        }

        op_keys.delete('$nin');
    }

    if (op_keys.has('$elemMatch')) {
        const op = build(params.$elemMatch);

        if (op) { new_args.push(new ElemMatch(path, op)); }

        op_keys.delete('$elemMatch');
    }

    if (op_keys.has('$regex')) {
        const expr = new RegExp(params.$regex, params.$options);

        new_args.push(new RegEx(path, expr));

        op_keys.delete('$regex');
        op_keys.delete('$options');
    }

    if (params.$exists && !new_args.length) {
        new_args.push(new Exists(path, true));

        op_keys.delete('$exists');
    }

    for (let name of op_keys) {
        if (name[0] === '$') { unknownOp(name); }
    }

    if (!new_args.length) { return withoutOps(); }

    parent_args.push(...new_args);

    return true;
};

export const build = (expr) => {
    const args = [];

    for (let field in expr) {
        let value = expr[field], result;

        if (field[0] !== '$') {
            result = buildClause(args, new Path(field), value);
        } else {
            if (!Array.isArray(value)) { value = [value]; }

            const fn = connectives[field];
            if (!fn) { unknownOp(field); }

            result = fn(args, value);
        }

        if (!result) { return result; }
    }

    if (!args.length) { return; }
    if (args.length === 1) { return args[0]; }

    return new Conjunction(args);
};
