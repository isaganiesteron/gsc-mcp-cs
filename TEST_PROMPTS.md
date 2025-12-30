# Google Search Console MCP Server - Test Prompts

Use these prompts in TypingMind to verify your MCP server is working correctly. Test them in order, or pick specific ones to verify particular functionality.

## Test Prompts (10 total)

### 1. Basic Connection Test
**Prompt:** "List all my Google Search Console properties."

**Expected:** Should call `list_sites` and return a list of your properties with permissions and types.

---

### 2. Site Details Verification
**Prompt:** "Get details about my main website property. Use the first site from my list if you need a site URL."

**Expected:** Should call `list_sites` first, then `get_site_details` with one of your site URLs, showing permission levels and access details.

---

### 3. Search Analytics - Basic Query
**Prompt:** "Show me search performance data for the last 30 days for my main website. Include top queries and pages."

**Expected:** Should call `search_analytics` with date range (last 30 days), showing clicks, impressions, CTR, and position data with top performing queries and pages.

---

### 4. URL Inspection
**Prompt:** "Inspect the homepage URL of my main website to check its indexing status."

**Expected:** Should call `inspect_url` with your homepage URL, returning indexing status, crawl information, and any issues detected.

---

### 5. Sitemap Listing
**Prompt:** "List all sitemaps submitted for my main website property."

**Expected:** Should call `list_sitemaps` and return all submitted sitemaps with their status and submission dates.

---

### 6. Period Comparison
**Prompt:** "Compare search performance between the last 30 days and the previous 30 days for my main website. Focus on clicks."

**Expected:** Should call `compare_periods` showing changes in clicks, impressions, CTR, and position between the two periods.

---

### 7. Keyword Opportunities
**Prompt:** "Find keyword opportunities for my website - queries ranking in positions 4-20 with good impressions but low clicks from the last 90 days."

**Expected:** Should call `find_keyword_opportunities` and return keywords that could be quick wins for improving rankings.

---

### 8. Device Breakdown
**Prompt:** "Show me how my website performs across different device types (desktop, mobile, tablet) for the last 30 days."

**Expected:** Should call `get_device_breakdown` showing performance metrics broken down by device type.

---

### 9. Geographic Analysis
**Prompt:** "Which countries drive the most traffic to my website? Show me the top 10 countries for the last 30 days."

**Expected:** Should call `get_country_breakdown` with topN=10, showing performance by country.

---

### 10. Batch URL Inspection
**Prompt:** "Check the indexing status of my homepage and a few key pages. Inspect 3-5 URLs from my main website."

**Expected:** Should call `batch_inspect_urls` with multiple URLs (up to 20), returning indexing status for each and identifying common patterns or issues.

---

## Quick Verification Checklist

After running all prompts, verify:
- [ ] All 10 prompts execute without errors
- [ ] Responses are formatted clearly (not raw JSON)
- [ ] Tool names are being called correctly
- [ ] Date formatting works (YYYY-MM-DD)
- [ ] Error handling works for invalid inputs
- [ ] OAuth token refresh works if tokens expire during testing
- [ ] Rate limiting is respected (especially for batch operations)

## Tips

1. **Start Simple**: Run test #1 first to verify basic connectivity
2. **Use Real Data**: The prompts use your actual website, so you'll see real results
3. **Check Logs**: If something fails, check Cloudflare Workers logs with `wrangler tail`
4. **Token Expiry**: If you see authentication errors, the server should auto-refresh tokens
5. **Date Ranges**: Adjust date ranges if your site doesn't have data for the suggested periods

## Expected Response Format

All tools should return human-readable text with:
- Clear section headers
- Formatted numbers (e.g., "1,234" not "1234")
- Visual indicators (✓, ⚠, ❌, →)
- Actionable insights and recommendations

If you see raw JSON or error stacks, there may be an issue with the tool response formatting.

