import {RESTService} from "@restfuncs/server";

export class CounterService extends RESTService {

    session = {
        counter: 0
    }

    async greet(name: string) {
        if(!this.session.counter) {
            this.session.counter = 0;
        }

        this.session.counter++;
        return `Hello ${name} from the server. Counter: ${this.session.counter}`
    }

    count() {
        this.session.counter++;
    }

    async getCounter() {
        return this.session.counter;
    }

    // ... more functions go here
}