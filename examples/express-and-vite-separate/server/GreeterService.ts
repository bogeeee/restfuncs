import {RestService} from "restfuncs-server";

export class GreeterService extends RestService {

    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // ... more functions go here
}