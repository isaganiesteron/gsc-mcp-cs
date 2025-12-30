# Postman Collection for GSC MCP Server

This directory contains Postman collections and environment files for testing the Google Search Console MCP Server.

## Files

- `GSC_MCP_Server.postman_collection.json` - Main Postman collection with all API endpoints
- `GSC_MCP_Server.postman_environment.json` - Environment variables for local testing

## Setup

1. **Import the Collection**
   - Open Postman
   - Click "Import" button
   - Select `GSC_MCP_Server.postman_collection.json`
   - The collection will appear in your workspace

2. **Import the Environment** (Optional but recommended)
   - Click "Import" button
   - Select `GSC_MCP_Server.postman_environment.json`
   - Select the environment from the dropdown in the top-right corner

3. **Update Environment Variables**
   - If your server runs on a different port, update `base_url` in the environment
   - Update `site_url` with your actual Google Search Console site URL

## Collection Structure

### 1. Health Check
- **GET /** - Simple health check endpoint

### 2. MCP Protocol
- **Initialize** - Initialize MCP connection
- **List Tools** - Get list of available tools
- **Initialized Notification** - Send initialized notification

### 3. Site Management
- **List Sites** - Get all GSC properties
- **Get Site Details** - Get details for a specific site

### 4. Search Analytics
- **Search Analytics - Basic** - Basic search data
- **Search Analytics - With Dimensions** - With query/page dimensions
- **Search Analytics - With Filters** - With query and device filters
- **Search Analytics - With Quick Wins** - With quick wins detection

### 5. URL Inspection
- **Inspect URL** - Inspect a single URL
- **Batch Inspect URLs** - Inspect multiple URLs (max 20)
- **Detect Indexing Issues** - Detect issues across URLs

### 6. Sitemaps
- **List Sitemaps** - List all sitemaps
- **Get Sitemap Details** - Get details for a specific sitemap

### 7. Advanced Analytics
- **Compare Periods** - Compare two time periods
- **Find Keyword Opportunities** - Find quick win opportunities
- **Get Device Breakdown** - Performance by device
- **Get Country Breakdown** - Performance by country

## Testing Workflow

1. **Start your server locally**
   ```bash
   npm run dev
   # or
   wrangler dev
   ```

2. **Test Health Check**
   - Run "Health Check" request
   - Should return server info

3. **Initialize MCP Connection**
   - Run "Initialize" request
   - Should return protocol version and capabilities

4. **List Available Tools**
   - Run "List Tools" request
   - Should return all available tools

5. **Test Individual Tools**
   - Update `siteUrl` in request body with your actual site URL
   - Update date ranges as needed
   - Run any tool request

## Request Format

All MCP requests follow JSON-RPC 2.0 format:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "tool_name",
    "arguments": {
      "param1": "value1",
      "param2": "value2"
    }
  }
}
```

## Response Format

Successful responses:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Response content here..."
      }
    ]
  }
}
```

Error responses:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "Error message here"
  }
}
```

## Notes

- **SSE Endpoint**: The server also supports Server-Sent Events (SSE) at `/sse`, but Postman doesn't support SSE directly. Use the POST endpoints instead.

- **Session-based Requests**: If using SSE, you'll get a session ID that should be used in subsequent requests to `/sse/message?sessionId={sessionId}`. For direct HTTP requests (which Postman uses), you can POST directly to `/sse`.

- **Authentication**: Make sure your Google OAuth credentials are properly configured in your Cloudflare Workers environment variables:
  - `GOOGLE_CLIENT_ID_TEAM`
  - `GOOGLE_CLIENT_SECRET_TEAM`
  - `GOOGLE_REFRESH_TOKEN` (in KV store `GSC_TOKENS`)

- **Date Format**: All dates must be in `YYYY-MM-DD` format (e.g., `2024-01-31`)

- **Site URL Format**: Site URLs can be:
  - URL-prefix: `https://example.com/`
  - Domain: `sc-domain:example.com`

## Troubleshooting

1. **Connection Refused**: Make sure your server is running on the port specified in `base_url`

2. **401 Unauthorized**: Check your OAuth credentials and refresh token

3. **404 Not Found**: Verify the site URL exists in your Google Search Console account

4. **400 Bad Request**: Check that all required parameters are provided and date formats are correct

5. **Rate Limiting**: The GSC API has rate limits. If you hit them, wait a few minutes before retrying

