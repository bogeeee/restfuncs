import typia from "typia"
import {remote, ServerSession} from "restfuncs-server";
type B = {
    id: number,
    name: string;
}

export class A extends ServerSession {
    propB: string




    /**
     * myJsDocComment ä ü ي
     * @param a aaaa
     * @param b bb
     * @param c
     * @see xy
     * @returns bla xy
     */
    @remote()
    myMethod(a: any, myCallback1: (a: string) => Promise<string>, b: B, ...c: ((a:number) => void)[]) {
        "marker"
    }

    @remote()
    myMethod2(a,b) {
        "marker"
    }
}

throw new Error("test to see if line numbers are correct");

// A validator that should be replaced by typia. Uncomment to test it
//const validator = (obj: unknown) => (typia.validate<B>(obj))