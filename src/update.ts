import {
    toPathPieces,
    get,
    set,
    modify,
    remove1,
    rename,
    equal,
    unknownOp,
    getIDBError
} from './util';


const modifyOp = (path_pieces, update, init) => (doc) => {
    modify(doc, path_pieces, update, init);
};

const arithOp = (fn) => (path_pieces, value1) => {
    const update = (obj, field) => {
        const value2 = obj[field];

        if (typeof value2 === 'number') {
            obj[field] = fn(value1, value2);
        }
    };

    const init = (obj, field) => obj[field] = 0;

    return modifyOp(path_pieces, update, init);
};

const compareOp = (fn) => (path_pieces, value) => {
    const update = (obj, field) => {
        if (fn(value, obj[field])) { obj[field] = value; }
    };

    const init = (obj, field) => obj[field] = value;

    return modifyOp(path_pieces, update, init);
};

const build = (steps, field, value) => {
    if (field[0] !== '$') {
        return steps.push(ops.$set(toPathPieces(field), value));
    }

    const op = ops[field];
    if (!op) { unknownOp(field); }

    for (let path in value) {
        steps.push(op(toPathPieces(path), value[path]));
    }
};


const ops = {

    $set: (path_pieces, value) => (doc) => {
        set(doc, path_pieces, value);
    },

    $unset: path_pieces => doc => remove1(doc, path_pieces),

    $rename: (path_pieces, new_name) => (doc) => {
        rename(doc, path_pieces, new_name);
    }
    ,

    $inc: arithOp((a, b) => a + b),
    $mul: arithOp((a, b) => a * b),
    $min: compareOp((a, b) => a < b),
    $max: compareOp((a, b) => a > b),
    $push: (path_pieces, value) => {
        const update = (obj, field) => {
            const elements = obj[field];

            if (Array.isArray(elements)) {
                elements.push(value);
            }
        };

        const init = (obj, field) => obj[field] = [value];

        return modifyOp(path_pieces, update, init);
    },

    $pop: (path_pieces, direction) => {
        let pop;

        if (direction < 1) {
            pop = e => e.shift();
        } else {
            pop = e => e.pop();
        }

        return (doc) => {
            get(doc, path_pieces, (obj, field) => {
                const elements = obj[field];

                if (Array.isArray(elements)) { pop(elements); }
            });
        };
    },

    $pullAll: (path_pieces, values) => (doc) => {
        get(doc, path_pieces, (obj, field) => {
            const elements = obj[field];
            if (!Array.isArray(elements)) { return; }

            const new_elements: any[] = [];

            const hasValue = (value1) => {
                for (let value2 of values) {
                    if (equal(value1, value2)) { return true; }
                }
            };

            for (let element of elements) {
                if (!hasValue(element)) {
                    new_elements.push(element);
                }
            }

            obj[field] = new_elements;
        });
    },

    $pull: (path_pieces, value) => {
        return ops.$pullAll(path_pieces, [value]);
    },

    $addToSet: (path_pieces, value) => (doc) => {
        get(doc, path_pieces, (obj, field) => {
            const elements = obj[field];
            if (!Array.isArray(elements)) { return; }

            for (let element of elements) {
                if (equal(element, value)) { return; }
            }

            elements.push(value);
        });
    },
};


export default (cur, spec, cb) => {
    const steps: any[]= [];

    for (let field in spec) { build(steps, field, spec[field]); }

    if (!steps.length) { return cb(null); }

    (function iterate() {
        cur._next((error, doc, idb_cur) => {
            if (!doc) { return cb(error); }

            for (let fn of steps) { fn(doc); }

            const idb_req = idb_cur.update(doc);

            idb_req.onsuccess = iterate;
            idb_req.onerror = e => cb(getIDBError(e));
        });
    })();
};
