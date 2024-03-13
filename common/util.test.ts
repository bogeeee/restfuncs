// util.test.ts
import {visitReplace} from './util';

describe('visitReplace', function() {
    it('should replace certain values and stop recursion', function() {
        const target = {a: 1, b: {c: 2, d: {e: 3, f: 4}}, g: 5, h:2};

        const result = visitReplace(target, (value, visitChilds) => {
            return value === 2 ? 'replaced' : visitChilds(value)
        });

        expect(result).toStrictEqual({a: 1, b: {c: 'replaced', d: {e: 3, f: 4}}, g: 5, h: 'replaced'});
    });

    it('should handle circular references correctly', function() {
        const target:any  = {a: 1, b: {c: 2}};
        target.d = target;  // Circular reference
        const visitor = (value: any) => value === 1 ? 'replaced' : undefined;

        const result = visitReplace(target, (value, visitChilds) => {
            return  value === 2 ? 'replaced' : visitChilds(value)
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

        const result = visitReplace(target, (value, visitChilds) => {
            return  value === 2 ? 'replaced' : visitChilds(value)
        });

        // Ensure the circular reference still exists in the result
        expect(result.b.d).toBe(result);
        result.b.d = "ok"

        expect(result).toStrictEqual({a: 1, b: {c: 'replaced', d: "ok"}});


    });
});