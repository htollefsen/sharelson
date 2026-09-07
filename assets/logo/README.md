# Logo source

`logo.svg` is the editable icon. `make.js` renders all PNG variants in `assets/images/`
(app icon, adaptive foreground and monochrome layers, splash icon). It needs the `sharp`
package, which is deliberately not a project dependency:

```bash
cd assets/logo && npm install --no-save sharp && node make.js ../images && rm -rf node_modules package-lock.json
```
