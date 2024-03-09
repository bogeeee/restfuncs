import {remote, ServerSession, ServerSessionOptions} from "restfuncs-server";

export class GreeterSession extends ServerSession {

    static options: ServerSessionOptions = {/* Configuration */}

    @remote()
    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // ... more remote methods go here
}