// Strips sourceMappingURL comments from bundled node_modules sources.
// Without this, comments like `//# sourceMappingURL=parse-proxy-response.js.map`
// (e.g. from https-proxy-agent, pulled in transitively by axios) get copied
// verbatim into dist/extension.js, and VS Code's debugger then fails trying to
// resolve those map files relative to dist/, which were never emitted there.
module.exports = function stripSourceMappingUrlLoader(source) {
  return source.replace(/[ \t]*\/\/[#@]\s*sourceMappingURL=.*(\r?\n|$)/g, '');
};
