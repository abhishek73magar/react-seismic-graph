// src uses extensionless imports (bundler style); let node find the .ts file
import { registerHooks } from 'node:module'
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx) } catch (e) { if(spec.startsWith('.')) return next(`${spec}.ts`, ctx); throw e }
  },
})
