Simple hello world example with express server and vite as packager.
Client(=web) and server are in separate packages / folders. The starter script entries are all under [server](server).

### Run it
```bash
git clone https://github.com/bogeeee/restfuncs.git
cd restfuncs/examples/express-and-vite-separate/server
npm install
npm run build
npm run start
```

### Development
```bash
npn run dev
```

#### With runtime type information

If you want to run in development with runtime type information (runtime arguments typechecking, ...) , add `ts-node` to devDependencies  and replace these run scripts (but it reloads way slower that with tsx):
```json
"dev": "nodemon -e ts --exec npm run dev_compileAndRunOnce",
"dev_compileAndRunOnce": "clear && ttsc --build && cross-env NODE_ENV=development ts-node server.js",
```

_Note that ts-node is not used standalone but on top of ttsc precompiled code. It's only purpose is to allow debugging. This is our way though the CommonJS/ESM-interop-typescript-compilation jungle ;)_