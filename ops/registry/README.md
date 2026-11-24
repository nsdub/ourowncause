# Our listing in the MCP Registry

We are listed in the official MCP Registry as `com.ourowncause/publication`, pointing at https://ourowncause.com/mcp. Look it up with:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.ourowncause"
```

`server.json` here is exactly what was published.

The `com.ourowncause` namespace is proven by a DNS TXT record on ourowncause.com: `v=MCPv1; k=ed25519; p=<public key>`. The private key that signed the login was deleted after publishing. To publish a new version, the holder of the Cloudflare account generates a new Ed25519 key and replaces the TXT record with the new public key. Then they run `mcp-publisher login dns --domain ourowncause.com` and `mcp-publisher publish` from this directory. The registry's own guide covers this: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx
