/**
 * A halt / break = the code execution on a certain breakpoint is currently paused.
 */
class Break<T> {
    breakPoint: BreakPoint<T>
    variables: T;
    resume: () => void;
    reject: (reason: any) => void;
    constructor(breakPoint: BreakPoint<T>, variables: T, resume: () => void, reject: (reason: any) => void) {
        this.breakPoint = breakPoint;
        this.variables = variables;
        this.resume = resume;
        this.reject = reject;
    }
}

type BreakPoint<T> = {
    id: string,
    condition?: (variables: T) => boolean
    hit: (variables: T) => Promise<void>
}

export class BreakPoints extends Set<BreakPoint<unknown>> {
    // *** State: Mind to reset it to initial values in the cleanUp method. ****
    public enabled = false;

    /**
     * Keep track of them for cleanup
     */
    currentBreaks = new Set<Break<any>>();

    /**
     * Offer a breakpoint
     * @param id
     * @param variables
     */
    async offer<T>(id: string, variables?: T) {
        if(!this.enabled) {
            return;
        }

        for(const bp of this) {
            if(id === bp.id && (!bp.condition || bp.condition(variables))) { // Breakpoint matches ?
                this.delete(bp); // Don't hit again, once hit.
                await bp.hit(variables);
            }
        }
    }

    async waitTilReached<T>(breakPointId: string, condition?: (variables: T) => boolean): Promise<Break<T>> {
        if(!this.enabled) {
            throw new Error("Breakpoints are not enabled")
        }

        return new Promise<Break<T>>((resolveHalt,rejectHalt) => {
            const bp: BreakPoint<T> = {
                id: breakPointId,
                condition,
                hit: (variables: T) => {
                    return new Promise<void>((resolveHit, rejectHit) => {
                        const resume = () => {
                            // Safety check:
                            if(!this.currentBreaks.has(brk)) {
                                throw new Error("Breakpoint was already resumed.");
                            }

                            this.currentBreaks.delete(brk);
                            resolveHit();
                        }
                        var brk = new Break<T>(bp,variables, resume, rejectHit);
                        this.currentBreaks.add(brk);
                        resolveHalt(brk);
                    });
                }
            };
            this.add(bp as BreakPoint<unknown>);

        });
    }

    /**
     * Call after the test is complete. Or also before it.
     */
    cleanUp() {
        this.enabled = false;
        this.clear();
        for(const brk of this.currentBreaks) {
            brk.reject(new Error(`Breakpoint id=${brk.breakPoint.id} is still halted.`));
        }
    }

}