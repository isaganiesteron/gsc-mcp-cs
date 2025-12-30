# Generating API Keys for GSC MCP Server

## Quick Generation Methods

### Method 1: Node.js (Recommended)
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
This generates a 64-character hexadecimal string (256 bits of entropy).

### Method 2: Using OpenSSL (if available)
```bash
openssl rand -hex 32
```

### Method 3: Using PowerShell (Windows)
```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

### Method 4: Online Generator
You can also use an online cryptographically secure random string generator, but be cautious about security.

## Configuration

### For Local Development

1. **Generate your API key** using one of the methods above
2. **Update `wrangler.jsonc`** - Uncomment and set the API_KEY:
   ```jsonc
   "vars": {
     // ... other vars ...
     "API_KEY": "your-generated-api-key-here"
   }
   ```
   Or create a `.dev.vars` file (recommended, gitignored):
   ```
   API_KEY=your-generated-api-key-here
   ```

3. **Update Postman environment** - Set the `api_key` variable to match

### For Production Deployment

**IMPORTANT**: Never commit API keys to your repository!

1. **Generate your API key** using one of the methods above

2. **Set as Cloudflare Secret** (recommended):
   ```bash
   wrangler secret put API_KEY
   ```
   When prompted, paste your generated API key.

3. **Verify the secret is set**:
   ```bash
   wrangler secret list
   ```

4. **Deploy your worker**:
   ```bash
   npm run deploy
   ```

### Multiple Environments

If you want different API keys for different environments:

```bash
# Production
wrangler secret put API_KEY --env production

# Staging
wrangler secret put API_KEY --env staging
```

## Security Best Practices

1. **Use strong keys**: At least 32 bytes (256 bits) of random data
2. **Never commit keys**: Use `.dev.vars` for local (should be gitignored) and `wrangler secret` for production
3. **Rotate keys regularly**: Generate new keys periodically and update secrets
4. **Use different keys**: Different keys for development, staging, and production
5. **Store securely**: If you need to share keys with team members, use a secure password manager or secrets management tool

## Rotating API Keys

If you need to rotate an API key:

1. Generate a new API key
2. Update the secret:
   ```bash
   wrangler secret put API_KEY
   ```
3. Update all clients to use the new key
4. The old key will stop working once all clients are updated

## Testing

After setting up your API key:

1. **Local testing**: Update `.dev.vars` or `wrangler.jsonc` and restart `wrangler dev`
2. **Postman testing**: Update the `api_key` environment variable
3. **Verify**: Make a request without the header - should get 401. With correct header - should work.

