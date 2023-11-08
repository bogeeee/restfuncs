import {remote, ServerSession, ServerSessionOptions} from "restfuncs-server";

export class GreeterSession extends ServerSession {

    static options: ServerSessionOptions = {
        checkArguments: (process.env.NODE_ENV === 'development'?undefined:true)
    }

    @remote()
    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // ... more remote methods go here
}