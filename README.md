# Google Search Console MCP Server

A Model Context Protocol (MCP) server that provides read-only access to Google Search Console data. This server is deployed to Cloudflare Workers and supports Server-Sent Events (SSE) transport for integration with TypingMind and other MCP clients.

## Features

- **12 Powerful Tools**: Comprehensive access to Google Search Console data organized into 4 tiers
- **SSE Support**: Real-time communication with MCP clients via Server-Sent Events
- **OAuth2 Authentication**: Secure user token-based authentication with automatic refresh
- **Cloudflare Workers**: Serverless deployment with global edge network
- **TypeScript**: Full type safety and excellent developer experience
- **Production Ready**: Includes error handling, CORS, rate limiting, and session management
- **TypingMind Compatible**: Tested and working with TypingMind MCP integration

## Tools Overview

### Tier 1: Site Management (3 tools)

1. **`list_sites`** - List all Google Search Console properties accessible to the authenticated user
2. **`get_site_details`** - Get detailed information about a specific Search Console property
3. **`search_analytics`** - Query comprehensive search performance data with advanced filtering and quick wins detection

### Tier 2: URL & Sitemap Inspection (4 tools)

4. **`inspect_url`** - Inspect a specific URL's indexing status and crawl information
5. **`batch_inspect_urls`** - Inspect multiple URLs at once and identify common patterns
6. **`list_sitemaps`** - List all sitemaps submitted for a site
7. **`get_sitemap_details`** - Get detailed information about a specific sitemap

### Tier 3: Advanced Analytics (5 tools)

8. **`compare_periods`** - Compare search performance between two time periods
9. **`find_keyword_opportunities`** - Identify quick win keyword opportunities (positions 4-20)
10. **`get_device_breakdown`** - Analyze performance across device types (desktop, mobile, tablet)
11. **`get_country_breakdown`** - Analyze performance across geographic regions
12. **`detect_indexing_issues`** - Detect and prioritize indexing issues across multiple URLs

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/gsc-mcp-cs.git
cd gsc-mcp-cs
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up OAuth2 credentials

You'll need Google OAuth2 credentials with the following scope:

- `https://www.googleapis.com/auth/webmasters.readonly`

**Required environment variables:**

- `GOOGLE_CLIENT_ID_TEAM` - Your Google OAuth client ID
- `GOOGLE_CLIENT_SECRET_TEAM` - Your Google OAuth client secret
- `GOOGLE_ACCESS_TOKEN` - Current access token (will be auto-refreshed)
- `GOOGLE_REFRESH_TOKEN` - Refresh token for token renewal

### 4. Configure Cloudflare Workers

Copy the example configuration:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Update `wrangler.jsonc` with your settings:

```jsonc
{
	"name": "gsc-mcp-server",
	"main": "src/index.ts",
	"compatibility_date": "2024-01-01",
	"vars": {
		"GOOGLE_CLIENT_ID_TEAM": "your-client-id",
		"GOOGLE_CLIENT_SECRET_TEAM": "your-client-secret"
	},
	"kv_namespaces": [
		{
			"binding": "GSC_TOKENS",
			"id": "your-kv-namespace-id"
		}
	]
}
```

### 5. Set up Cloudflare Workers KV

Create a KV namespace for storing OAuth tokens:

```bash
wrangler kv:namespace create GSC_TOKENS
```

This will output a namespace ID. Add it to your `wrangler.jsonc` file.

### 6. Set secrets

Set sensitive values as Cloudflare Workers secrets:

```bash
wrangler secret put GOOGLE_CLIENT_ID_TEAM
wrangler secret put GOOGLE_CLIENT_SECRET_TEAM
wrangler secret put GOOGLE_ACCESS_TOKEN
wrangler secret put GOOGLE_REFRESH_TOKEN
```

### 7. Test locally

```bash
npm run dev
```

Your server will be available at `http://localhost:8787`

Test the health endpoint:

```bash
curl http://localhost:8787
```

### 8. Deploy to Cloudflare Workers

```bash
npm run deploy
```

After deployment, Cloudflare will provide your worker URL (e.g., `https://gsc-mcp-server.YOUR_SUBDOMAIN.workers.dev`)

## Using with TypingMind

1. Deploy your MCP server to Cloudflare Workers
2. In TypingMind, go to Settings → MCP Servers
3. Add a new server:
   - **Name**: Google Search Console MCP Server
   - **URL**: Your Cloudflare Worker URL (e.g., `https://gsc-mcp-server.YOUR_SUBDOMAIN.workers.dev/sse`)
   - **Transport**: SSE
4. Test the connection

## API Endpoints

- `GET /` - Health check endpoint
- `GET /sse` - SSE endpoint for establishing connection
- `POST /sse` - Direct HTTP endpoint (for clients that don't use SSE)
- `POST /sse/message?sessionId={id}` - Message endpoint for active SSE sessions

## Tool Documentation

### Tier 1: Site Management

#### `list_sites`

Retrieves all Google Search Console properties that the authenticated user has access to.

**Parameters**: None

**Example Response:**

```
Google Search Console Properties:

You have access to 3 properties:

1. https://example.com/
   Permission: Site Owner
   Type: URL-prefix property

2. sc-domain:example.com
   Permission: Site Owner
   Type: Domain property

3. https://blog.example.com/
   Permission: Full User
   Type: URL-prefix property

Total: 3 properties
```

#### `get_site_details`

Retrieves detailed information about a specific Search Console property.

**Parameters:**

- `siteUrl` (string, required): The site URL (e.g., "https://example.com/" or "sc-domain:example.com")

**Example Response:**

```
Site Property Details:

Site URL: https://example.com/
Permission Level: siteOwner
Property Type: URL-prefix property

✓ Access Level: Full Owner - Can manage all aspects

This property is properly configured and accessible.
```

#### `search_analytics`

Retrieves comprehensive search performance data with advanced filtering and quick wins detection.

**Parameters:**

- `siteUrl` (string, required): Site URL
- `startDate` (string, required): Start date in YYYY-MM-DD format
- `endDate` (string, required): End date in YYYY-MM-DD format
- `dimensions` (string[], optional): Array of dimensions - valid values: "query", "page", "country", "device", "searchAppearance", "date"
- `type` (string, optional): Search type - valid values: "web", "image", "video", "news", "discover", "googleNews". Default: "web"
- `rowLimit` (number, optional): Maximum rows to return. Range: 1-25000. Default: 1000
- `startRow` (number, optional): Starting row for pagination. Default: 0
- `pageFilter` (string, optional): Filter by page URL. Use "regex:" prefix for regex patterns
- `queryFilter` (string, optional): Filter by search query. Use "regex:" prefix for regex patterns
- `countryFilter` (string, optional): Filter by country ISO 3166-1 alpha-3 code
- `deviceFilter` (string, optional): Filter by device type - valid values: "DESKTOP", "MOBILE", "TABLET"
- `detectQuickWins` (boolean, optional): Enable automatic detection of SEO optimization opportunities. Default: false

**Example Response:**

```
Search Performance Summary:

Site: https://example.com/
Date Range: 2024-01-01 to 2024-01-31
Dimensions: query, page
Row Limit: 1000 (showing 1000 rows)

Overall Metrics:
- Total Clicks: 12,345
- Total Impressions: 456,789
- Average CTR: 2.70%
- Average Position: 8.5

Performance Indicators:
⚠ Click-through rate is below industry average (5%)
✓ Average position is strong (first page)

Top Performing Queries:
1. "example query"
   Page: https://example.com/page
   Clicks: 1,234 | Impressions: 45,678
   CTR: 2.70% | Position: 3.2

Quick Win Opportunities Detected:
1. "opportunity query" (https://example.com/opportunity)
   Position: 5.2 | Impressions: 2,345
   Current CTR: 1.5%
   → Optimize title tag and meta description to improve CTR
```

### Tier 2: URL & Sitemap Inspection

#### `inspect_url`

Retrieves detailed indexing information for a specific URL.

**Parameters:**

- `siteUrl` (string, required): The site URL property
- `inspectionUrl` (string, required): The full URL to inspect
- `languageCode` (string, optional): Language code for response. Default: "en-US"

**Example Response:**

```
URL Inspection Results:

URL: https://example.com/page
Site Property: https://example.com/
Last Crawled: 2024-01-15T10:30:00Z

Index Status:
✓ Overall Verdict: PASS
Coverage State: Submitted and indexed

Crawling & Indexing:
✓ Indexing: Allowed
✓ Robots.txt: Allowed
✓ Page Fetch: Successful

Canonical URLs:
- Google's Canonical: https://example.com/page
- User-Declared Canonical: https://example.com/page
✓ Canonicals match

Mobile Usability:
✓ Passed
No mobile usability issues

Rich Results:
✓ Valid structured data
Detected items:
  - Article
  - BreadcrumbList

✓ This URL is healthy and properly indexed by Google.
```

#### `batch_inspect_urls`

Inspects multiple URLs at once and identifies common indexing patterns.

**Parameters:**

- `siteUrl` (string, required): The site URL property
- `urls` (string[], required): Array of URLs to inspect (max 20 per call)
- `languageCode` (string, optional): Language code. Default: "en-US"

#### `list_sitemaps`

Retrieves all sitemaps submitted for a site.

**Parameters:**

- `siteUrl` (string, required): The site URL property
- `sitemapIndex` (string, optional): URL of sitemap index to list entries from

#### `get_sitemap_details`

Retrieves detailed information about a specific sitemap.

**Parameters:**

- `siteUrl` (string, required): The site URL property
- `feedpath` (string, required): The sitemap URL (e.g., "https://example.com/sitemap.xml")

### Tier 3: Advanced Analytics

#### `compare_periods`

Compares search performance between two time periods.

**Parameters:**

- `siteUrl` (string, required): Site URL
- `period1StartDate` (string, required): First period start (YYYY-MM-DD)
- `period1EndDate` (string, required): First period end (YYYY-MM-DD)
- `period2StartDate` (string, required): Second period start (YYYY-MM-DD)
- `period2EndDate` (string, required): Second period end (YYYY-MM-DD)
- `dimensions` (string[], optional): Dimensions to compare. Default: ["query"]
- `metric` (string, optional): Metric to compare - valid values: "clicks", "impressions", "ctr", "position". Default: "clicks"

#### `find_keyword_opportunities`

Identifies search queries ranking on positions 4-20 with high impressions but low clicks.

**Parameters:**

- `siteUrl` (string, required): Site URL
- `startDate` (string, required): Start date (YYYY-MM-DD)
- `endDate` (string, required): End date (YYYY-MM-DD)
- `minPosition` (number, optional): Minimum position to consider. Default: 4
- `maxPosition` (number, optional): Maximum position to consider. Default: 20
- `minImpressions` (number, optional): Minimum impressions threshold. Default: 100
- `maxCtr` (number, optional): Maximum CTR percentage to flag. Default: 3

#### `get_device_breakdown`

Analyzes search performance across different device types.

**Parameters:**

- `siteUrl` (string, required): Site URL
- `startDate` (string, required): Start date (YYYY-MM-DD)
- `endDate` (string, required): End date (YYYY-MM-DD)
- `additionalDimension` (string, optional): Additional dimension to break down by (e.g., "query", "page"). Default: none

#### `get_country_breakdown`

Analyzes search performance across different countries.

**Parameters:**

- `siteUrl` (string, required): Site URL
- `startDate` (string, required): Start date (YYYY-MM-DD)
- `endDate` (string, required): End date (YYYY-MM-DD)
- `topN` (number, optional): Number of top countries to return. Default: 10
- `additionalDimension` (string, optional): Additional dimension (e.g., "query"). Default: none

#### `detect_indexing_issues`

Checks multiple URLs for indexing problems and provides a prioritized list of issues.

**Parameters:**

- `siteUrl` (string, required): Site URL
- `urls` (string[], required): Array of URLs to check (max 20)

## Example Usage Scenarios

### Scenario 1: SEO Audit

```
1. list_sites → Get all properties
2. get_site_details → Verify ownership
3. detect_indexing_issues → Check important pages
4. find_keyword_opportunities → Identify quick wins
```

### Scenario 2: Content Performance Analysis

```
1. search_analytics → Get last 90 days data
2. compare_periods → Compare with previous 90 days
3. get_device_breakdown → Check mobile vs desktop
4. get_country_breakdown → See geographic distribution
```

### Scenario 3: Technical SEO Check

```
1. list_sitemaps → Review all sitemaps
2. get_sitemap_details → Check for errors
3. batch_inspect_urls → Verify indexing
4. detect_indexing_issues → Prioritize fixes
```

## Authentication

The server uses OAuth2 with user tokens (not service accounts). The authentication flow includes:

1. **Token Storage**: OAuth tokens are stored in Cloudflare Workers KV
2. **Automatic Refresh**: Access tokens are automatically refreshed when expired using the refresh token
3. **Scope**: `https://www.googleapis.com/auth/webmasters.readonly` (read-only access)

### Getting OAuth2 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the "Google Search Console API"
4. Create OAuth 2.0 credentials (OAuth client ID)
5. Configure the OAuth consent screen
6. Add authorized redirect URIs
7. Download the client ID and secret

### Token Management

The server automatically handles token refresh. You only need to provide:

- Initial access token
- Refresh token

These can be obtained through the OAuth2 flow or from existing integrations.

## Rate Limits

- **URL Inspection API**: ~600 calls/minute per property
- **Search Analytics API**: No specific limit, but be reasonable
- **Batch Operations**: The server automatically adds delays between requests to respect rate limits

## Response Formatting

All tools return human-readable formatted text (not raw JSON) to make responses easy to understand for both AI assistants and users. Responses include:

- Clear section headers
- Formatted numbers (e.g., "1,000" not "1000")
- Visual indicators (✓, ⚠, ❌, →)
- Context and interpretation
- Actionable insights and recommendations

## Project Structure

```
.
├── src/
│   └── index.ts          # Main MCP server code
├── test/
│   └── index.spec.ts     # Tests
├── wrangler.jsonc.example  # Example Cloudflare Workers config
├── wrangler.jsonc        # Cloudflare Workers config (gitignored)
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript config
└── README.md             # This file
```

## Development

### Running Tests

```bash
npm test
```

The project includes Vitest with Cloudflare Workers test environment.

### Type Generation

Generate Cloudflare Workers types:

```bash
npm run cf-typegen
```

## Troubleshooting

### "Tool not found" error

- Ensure tool names match exactly (case-sensitive)
- Check that tool is implemented in `src/index.ts`
- Verify the tool is being exported in tools/list response

### SSE connection issues

- Check CORS headers if connecting from a web app
- Verify firewall isn't blocking SSE connections
- Test with `curl -N http://localhost:8787/sse` to see raw SSE stream

### OAuth token errors

- Verify tokens are correctly set in Cloudflare Workers secrets
- Check that refresh token is valid and not expired
- Ensure OAuth scope includes `webmasters.readonly`
- Review Cloudflare Workers logs: `wrangler tail`

### Deployment fails

- Ensure you're logged in to Cloudflare: `wrangler login`
- Check that worker name in wrangler.jsonc is unique
- Verify your Cloudflare account has Workers enabled
- Ensure KV namespace is created and bound correctly

## API Reference

### Google Search Console API

- **API Version**: v3 (for most endpoints), v1 (for URL Inspection)
- **Base URL (v3)**: `https://www.googleapis.com/webmasters/v3`
- **Base URL (v1)**: `https://searchconsole.googleapis.com/v1`
- **Documentation**: [Google Search Console API](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing)

### Key Endpoints Used

- `GET /sites` - List all sites
- `GET /sites/{siteUrl}` - Get site details
- `POST /sites/{siteUrl}/searchAnalytics/query` - Query search analytics
- `POST /urlInspection/index:inspect` - Inspect URL
- `GET /sites/{siteUrl}/sitemaps` - List sitemaps
- `GET /sites/{siteUrl}/sitemaps/{feedpath}` - Get sitemap details

## Resources

- [MCP Protocol Documentation](https://modelcontextprotocol.io/)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Google Search Console API](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing)
- [URL Inspection API](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect)
- [Search Analytics Query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Support

If you encounter issues:

1. Check the Troubleshooting section above
2. Review Cloudflare Workers logs: `wrangler tail`
3. Open an issue on GitHub with:
   - Your wrangler.jsonc (remove sensitive data)
   - Error messages from logs
   - Steps to reproduce

---

Built with the Model Context Protocol (MCP) for TypingMind and other MCP clients.
