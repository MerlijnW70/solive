import type { ResolveHook } from "node:module";

export const resolve: ResolveHook = async (specifier, context, next) => {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
};
