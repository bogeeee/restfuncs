import typia from "typia"
import {remote, ServerSession} from "restfuncs-server";
type B = {
    id: number,
    name: string;
}

export class A extends ServerSession {
    propB: string




    /**
     * myJsDocComment
     * @param a aaaa
     * @param b bb
     * @param c
     * @see xy
     * @returns bla xy
     */
    @remote()
    myMethod(a: any, b: B, ...c: B[]) {
        "marker"
    }


}

throw new Error("test to see if line numbers are correct");

// A validator that should be replaced by typia. Uncomment to test it
//const validator = (obj: unknown) => (typia.validate<B>(obj))