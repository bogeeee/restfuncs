import {RESTService} from "@restfuncs/server";

export class GreeterService extends RESTService {

    session: {counter?: number} = null;

    async greet(name: string) {
        if(!this.session.counter) {
            this.session.counter = 0;
        }

        this.session.counter++;
        return `Hello ${name} from the server. Counter: ${this.session.counter}`
    }

    // ... more functions go here
}