// util.test.ts
import {visitReplace} from './util.js';

describe('visitReplace', function() {
    it('should replace certain values and stop recursion', function() {
        const target = {a: 1, b: {c: 2, d: {e: 3, f: 4}}, g: 5, h:2};

        const result = visitReplace(target, (value, visitChilds, context) => {
            return value === 2 ? 'replaced' : visitChilds(value, context)
        });

        expect(result).toStrictEqual({a: 1, b: {c: 'replaced', d: {e: 3, f: 4}}, g: 5, h: 'replaced'});
    });

    it('should replace certain values and stop recursion - sets', function() {
        const target = {a: 1, b: new Set([1,2,3])};

        const result = visitReplace(target, (value, visitChilds, context) => {
            return value === 2 ? 'replaced' : visitChilds(value, context)
        });

        expect(result).toStrictEqual({a: 1, b: new Set([1,"replaced",3])});
    });

    it('should replace certain values and stop recursion - sets 2', function() {
        const target = {a: 1, b: new Set([1, {x: 2},3])};

        const result = visitReplace(target, (value, visitChilds, context) => {
            return value === 2 ? 'replaced' : visitChilds(value, context)
        });

        expect(result).toStrictEqual({a: 1, b: new Set([1,{x:"replaced"},3])});
    });

    it('should replace certain values and stop recursion - maps - values ', function() {
        const target = {a: 1, b: new Map<any, any>([["a",1], ["b", 2], ["c", 3]])};

        const result = visitReplace(target, (value, visitChilds, context) => {
            return value === 2 ? 'replaced' : visitChilds(value, context)
        });

        expect(result).toStrictEqual({a: 1, b: new Map<any, any>([["a",1], ["b", "replaced"], ["c", 3]])});
    });

    it('should replace certain values and stop recursion - maps - values 2', function() {
        const target = {a: 1, b: new Map<any, any>([["a",1], ["b", {x:2}], ["c", 3]])};

        const result = visitReplace(target, (value, visitChilds, context) => {
            return value === 2 ? 'replaced' : visitChilds(value, context)
        });

        expect(result).toStrictEqual({a: 1, b: new Map<any, any>([["a",1], ["b", {x: "replaced"}], ["c", 3]])});
    });

    it('should replace certain values and stop recursion - maps - keys ', function() {
        const target = {a: 1, b: new Map<any, any>([["a",1], [2, "x"], ["c", 3]])};

        const result = visitReplace(target, (value, visitChilds, context) => {
            return value === 2 ? 'replaced' : visitChilds(value, context)
        });

        expect(result).toStrictEqual({a: 1, b: new Map<any, any>([["a",1], ["replaced", "x"], ["c", 3]])});
    });

    it('should replace certain values and stop recursion - maps - keys 2', function() {
        const target = {a: 1, b: new Map<any, any>([["a",1], [{x:2}, "y"], ["c", 3]])};

        const result = visitReplace(target, (value, visitChilds, context) => {
            return value === 2 ? 'replaced' : visitChilds(value, context)
        });

        expect(result).toStrictEqual({a: 1, b: new Map<any, any>([["a",1], [{x: "replaced"}, "y"], ["c", 3]])});
    });

    it('should handle circular references correctly', function() {
        const target:any  = {a: 1, b: {c: 2}};
        target.d = target;  // Circular reference
        const visitor = (value: any) => value === 1 ? 'replaced' : undefined;

        const result = visitReplace(target, (value, visitChilds, context) => {
            return  value === 2 ? 'replaced' : visitChilds(value, context)
        });

        // Ensure the circular reference still exists in the result
        expect(result.d).toBe(result);

        result.d = "ok"

        expect(result).toStrictEqual({a: 1, b: {c: 'replaced'}, d: "ok"});


    });

    it('should handle circular references correctly (one level deeper)', function() {
        const target:any  = {a: 1, b: {c: 2}};
        target.b.d = target;  // Circular reference
        const visitor = (value: any) => value === 1 ? 'replaced' : undefined;

        const result = visitReplace(target, (value, visitChilds, context) => {
            return  value === 2 ? 'replaced' : visitChilds(value, context)
        });

        // Ensure the circular reference still exists in the result
        expect(result.b.d).toBe(result);
        result.b.d = "ok"

        expect(result).toStrictEqual({a: 1, b: {c: 'replaced', d: "ok"}});


    });
});