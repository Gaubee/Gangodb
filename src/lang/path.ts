import { toPathPieces } from '../util';

export default class Path {
    pieces: string[]
    literal: string
    constructor(path: string) {
        this.pieces = toPathPieces(path);
        this.literal = path;
    }
}
