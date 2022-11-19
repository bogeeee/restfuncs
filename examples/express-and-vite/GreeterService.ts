import {RESTService} from "@restfuncs/server";

export class GreeterService extends RESTService {

    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // ... more functions go here
}