import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	alias: {
		"@peculiar/acme-client": "@peculiar/acme-client/build/es2015/index.js",
	},
	types: {
		generate: false,
	},
});
