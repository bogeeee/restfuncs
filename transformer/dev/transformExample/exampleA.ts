import typia from "typia"
function remote() {
    return function (...args: any[]) {
        console.log("decorated")
    }
}
type B = {
    id: number,
    name: string;
}

export class A {
    propB: string

    @remote()
    myMethod(b: B) {
        "marker"
    }
}

// A validator that should be replaced by typia. Uncomment to test it
//const validator = (obj: unknown) => (typia.validate<B>(obj))