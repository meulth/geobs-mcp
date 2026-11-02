import swaggerJavaScript from "swagger-ui-dist/swagger-ui-bundle.js?raw";
import swaggerCss from "swagger-ui-dist/swagger-ui.css?raw";
import { DOCS_PROTOCOL_VERSION, MCP_ACCEPT } from "./openapi";

export function documentationResponse(path: string, basePath: string): Response | undefined {
  const assetBase = `${basePath}/docs`;
  const headers = {
    "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "referrer-policy": "no-referrer"
  };
  if (path === "/docs" || path === "/docs/") return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeoBS MCP API</title><link rel="icon" href="data:,"><link rel="stylesheet" href="${assetBase}/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="${assetBase}/swagger-ui-bundle.js"></script><script src="${assetBase}/swagger-initializer.js"></script></body></html>`, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  if (path === "/docs/swagger-ui.css") return new Response(swaggerCss, { headers: { ...headers, "content-type": "text/css; charset=utf-8" } });
  if (path === "/docs/swagger-ui-bundle.js") return new Response(swaggerJavaScript, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
  if (path === "/docs/swagger-initializer.js") return new Response(`"use strict";
window.ui = SwaggerUIBundle({
  url: ${JSON.stringify(`${basePath}/openapi.json`)}, dom_id: "#swagger-ui", deepLinking: true,
  validatorUrl: null, queryConfigEnabled: false, supportedSubmitMethods: ["post"],
  persistAuthorization: false, displayRequestDuration: true,
  requestInterceptor: function(request) {
    if (request.method && request.method.toUpperCase() === "POST") {
      var headers = new Headers(request.headers);
      headers.set("Accept", ${JSON.stringify(MCP_ACCEPT)});
      headers.set("Content-Type", "application/json");
      headers.set("MCP-Protocol-Version", ${JSON.stringify(DOCS_PROTOCOL_VERSION)});
      request.headers = Object.fromEntries(headers);
    }
    return request;
  }
});`, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
}
