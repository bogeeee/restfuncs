// *** Duplicate code (of ../common/util.ts) because it is hard to import "restfuncs-common" from inside a **commonjs** project ***

type VisitReplaceContext = {
    /**
     * Not safely escaped. Should be used for diag only !
     */
    diagnosis_path?: string

    parentObject?: object
    key?: unknown
}

function diagnosis_jsonPath(key: unknown) {
    if(!Number.isNaN(Number(key))) {
        return `[${key}]`;
    }
    return `.${key}`;
}

type VisitReplaceOptions = {
    /**
     * whether to pass on the context object. This hurts performance because the path is concatted every time, so use it only when needed. Setting this to "onError" re-executes the visitprelace with trackPath when an error was thrown
     */
    trackPath?: boolean | "onError",

    /**
     * Keep the order of sets and maps when replacing elements. Default: false
     */
    keepOrder?: boolean
}

/**
 * Usage:
 *  <pre><code>
 *  const result = visitReplace(target, (value, visitChilds, context) => {
 *      return value === 'needle' ? 'replaced' : visitChilds(value, context)
 *  });
 *  </code></pre>
 *
 * @param value
 * @param visitor
 */
export function visitReplace<O extends object>(value: O, visitor: (value: unknown, visitChilds: (value: unknown, context: VisitReplaceContext) => unknown, context: VisitReplaceContext) => unknown , options: VisitReplaceOptions= {}): O {
    const visisitedObjects = new Set<object>()

    function visitChilds(value: unknown, context: VisitReplaceContext) {
        if(value === null) {
            return value;
        }
        else if(typeof value === "object") {
            const obj = value as object;
            if (visisitedObjects.has(obj)) {
                return value; // don't iterate again
            }
            visisitedObjects.add(obj);

            if (value instanceof Set) {
                let set = obj as Set<unknown>;
                if (options.keepOrder) {
                    throw new Error("Keep order not yet implemented");
                }
                for (const childValue of [...set.values()]) {
                    let newValue = visitor(childValue, visitChilds, {
                        ...context,
                        parentObject: value,
                        key: childValue,
                        diagnosis_path: (context.diagnosis_path !== undefined ? context.diagnosis_path! : undefined)
                    });

                    if (newValue !== childValue) { // Only if childValue really has changed. We don't want to interfer with setting a readonly property and trigger a proxy
                        // Replace:
                        set.delete(childValue); set.add(newValue);
                    }
                }

            }
            else if (value instanceof Map) {
                let map = obj as Map<unknown, unknown>;
                if (options.keepOrder) {
                    throw new Error("Keep order not yet implemented");
                }

                // Keys:
                for (const key of [...map.keys()]) {
                    let newKey = visitor(key, visitChilds, {
                        ...context,
                        parentObject: value,
                        key: key,
                        diagnosis_path: (context.diagnosis_path !== undefined ? `${context.diagnosis_path!}${diagnosis_jsonPath(key)}` : undefined)
                    });

                    if (newKey !== key) { // Only if key really has changed. We don't want to interfer with setting a readonly property and trigger a proxy
                        // Replace key:
                        let value = map.get(key);
                        map.delete(key);
                        map.set(newKey, value);
                    }
                }

                // Values:
                for (const [key, childValue] of [...map.entries()]) {
                    let newValue = visitor(childValue, visitChilds, {
                        ...context,
                        parentObject: value,
                        key: key,
                        diagnosis_path: (context.diagnosis_path !== undefined ? `${context.diagnosis_path!}${diagnosis_jsonPath(key)}` : undefined)
                    });

                    if (newValue !== childValue) { // Only if childValue really has changed. We don't want to interfer with setting a readonly property and trigger a proxy
                        map.set(key, newValue);
                    }
                }

            }
            else {
                for (let k in obj) {
                    const keyInParent = k as keyof object;
                    const childValue = obj[keyInParent];
                    let newValue = visitor(childValue, visitChilds, {
                        ...context,
                        parentObject: value,
                        key: keyInParent,
                        diagnosis_path: (context.diagnosis_path !== undefined ? `${context.diagnosis_path!}${diagnosis_jsonPath(keyInParent)}` : undefined)
                    });
                    if (newValue !== childValue) { // Only if childValue really has changed. We don't want to interfer with setting a readonly property and trigger a proxy
                        // @ts-ignore
                        obj[keyInParent] = newValue;
                    }
                }
            }
        }
        return value;
    }

    if(options.trackPath === "onError") {
        try {
            return visitor(value,  visitChilds, {}) as O; // Fast try without context
        }
        catch (e) {
            return visitReplace(value,  visitor, {...options, trackPath: true}); // Try again with context
        }
    }

    return visitor(value, visitChilds,{diagnosis_path: options.trackPath?"":undefined}) as O;
}
