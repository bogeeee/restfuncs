import {RestfuncsOptions, RestService} from "restfuncs-server";
import session from "express-session";
import express from "express"

const app = express()

app.use("/test", function (req, res, next) {
    let x: express.Request
    x.session.destroy((() => {}))
});

export class ControlService extends RestService {
    services: { [name: string]: { service: RestService;} }

    constructor(services: { [p: string]: { service: RestService } }) {
        super();
        this.services = services;
    }

    async resetSession() {
        if(!this.req.session) {
            return;
        }

        const session = this.req.session;

        await new Promise<void>(function executor(resolve, reject) { // with an arrow function, it gives some super strange compile error
            session.destroy((err) => {if(!err) resolve(); else reject(err)})
        })
    }
    async getCorsReadTokenForService(name: string) {
        return await this.services[name].service.getCorsReadToken()
    }


    async getCsrfTokenForService(name: string) {
        return this.services[name].service.getCsrfToken()
    }


}