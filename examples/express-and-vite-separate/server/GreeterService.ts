import {Service} from "restfuncs-server";

export class GreeterService extends Service {

    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // ... more functions go here
}