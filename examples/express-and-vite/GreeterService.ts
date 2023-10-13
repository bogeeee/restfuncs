import {ServerSession} from "restfuncs-server";

export class GreeterService extends ServerSession {

    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // ... more functions go here
}