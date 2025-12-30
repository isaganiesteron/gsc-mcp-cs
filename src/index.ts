/// <reference types="../worker-configuration.d.ts" />

/**
 * ============================================================================
 * CUSTOMIZATION SECTION - Update these values for your MCP server
 * ============================================================================
 */
const CONFIG = {
	serverName: 'gsc-mcp-server',
	serverVersion: '1.0.0',
	serverDescription: 'Google Search Console MCP Server',
	protocolVersion: '2024-11-05',
	keepAliveInterval: 30000, // 30 seconds
} as const;

/**
 * ============================================================================
 * TOOL DEFINITIONS - Add your custom tools here
 * ============================================================================
 * Each tool should have:
 * - name: unique identifier for the tool
 * - description: what the tool does
 * - inputSchema: JSON schema defining the input parameters
 * - handler: function that executes the tool logic
 */

interface Tool {
	name: string;
	description: string;
	inputSchema: {
		type: string;
		properties: Record<string, { type: string; description: string }>;
		required: string[];
	};
	handler: (args: Record<string, unknown>, env: Env) => Promise<ToolResult> | ToolResult;
}

// Type helper for array operations
type ArrayType<T> = T extends (infer U)[] ? U : never;

interface ToolResult {
	content: Array<{
		type: string;
		text: string;
	}>;
}

/**
 * ============================================================================
 * AUTHENTICATION HELPERS
 * ============================================================================
 */

/**
 * Generate insights from search analytics data
 */
function generateInsights(data: {
	totalClicks: number;
	totalImpressions: number;
	avgCtr: number;
	avgPosition: number;
	rows: Array<{ clicks: number; impressions: number; ctr: number; position: number }>;
}): string {
	const insights: string[] = [];

	if (data.totalClicks === 0) {
		insights.push('⚠ No clicks recorded in this period. Consider reviewing your content strategy and keyword targeting.');
	}

	if (data.avgCtr < 2) {
		insights.push('⚠ CTR is below 2%. Consider optimizing title tags and meta descriptions to improve click-through rates.');
	} else if (data.avgCtr < 5) {
		insights.push('→ CTR is below industry average (5%). There is room for improvement in title and description optimization.');
	}

	if (data.avgPosition > 20) {
		insights.push('⚠ Average position is beyond page 2. Focus on improving content quality and relevance for target keywords.');
	} else if (data.avgPosition > 10) {
		insights.push('→ Average position is on page 2. Optimize content to push rankings to page 1.');
	}

	if (data.totalImpressions > 0 && data.totalClicks === 0) {
		insights.push('⚠ High impressions but zero clicks suggests content may not match search intent. Review and update content.');
	}

	if (data.rows.length > 0) {
		const topPerformer = data.rows[0];
		if (topPerformer.position <= 3 && topPerformer.ctr > 5) {
			insights.push(
				`✓ Top performing query has strong position (${topPerformer.position.toFixed(1)}) and healthy CTR (${topPerformer.ctr.toFixed(
					2
				)}%).`
			);
		}
	}

	return insights.length > 0 ? insights.join('\n') : '✓ Performance metrics are within healthy ranges.';
}

/**
 * Generate recommendations from search analytics data
 */
function generateRecommendations(data: { avgCtr: number; avgPosition: number; totalClicks: number }): string {
	const recommendations: string[] = [];

	if (data.avgCtr < 5) {
		recommendations.push('- Improve meta descriptions to increase CTR');
		recommendations.push('- A/B test title tags to find more compelling variations');
	}

	if (data.avgPosition > 10) {
		recommendations.push('- Optimize content for better rankings');
		recommendations.push('- Build high-quality backlinks to improve domain authority');
	}

	if (data.totalClicks === 0) {
		recommendations.push('- Review keyword targeting and content relevance');
		recommendations.push('- Check for technical SEO issues that may prevent indexing');
	}

	recommendations.push('- Monitor top performing queries and create similar content');
	recommendations.push('- Use find_keyword_opportunities tool to identify quick wins');

	return recommendations.join('\n');
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
	token_type: string;
}

/**
 * Refresh OAuth2 access token using refresh token
 */
async function refreshAccessToken(env: Env): Promise<string> {
	const clientId = env.GOOGLE_CLIENT_ID_TEAM;
	const clientSecret = env.GOOGLE_CLIENT_SECRET_TEAM;

	// Get refresh token from env var first, fallback to KV
	let refreshToken: string | undefined = env.GOOGLE_REFRESH_TOKEN;
	if (!refreshToken && env.GSC_TOKENS) {
		const kvToken = await env.GSC_TOKENS.get('GOOGLE_REFRESH_TOKEN');
		refreshToken = kvToken || undefined;
	}

	if (!refreshToken) {
		throw new Error(
			'Refresh token not found. Please set GOOGLE_REFRESH_TOKEN in env vars (wrangler.jsonc vars or .dev.vars) or KV storage.'
		);
	}

	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			client_id: clientId || '',
			client_secret: clientSecret || '',
			refresh_token: refreshToken,
			grant_type: 'refresh_token',
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to refresh token: ${error}`);
	}

	const data = (await response.json()) as TokenResponse;

	// Cache new access token in KV if available (env vars are read-only)
	if (env.GSC_TOKENS) {
		await env.GSC_TOKENS.put('GOOGLE_ACCESS_TOKEN', data.access_token);
	}

	return data.access_token;
}

/**
 * Get valid access token (refresh if needed)
 */
async function getAccessToken(env: Env): Promise<string> {
	// Try env variable first (primary source)
	let accessToken: string | undefined = env.GOOGLE_ACCESS_TOKEN;

	// If not in env, try KV cache
	if (!accessToken && env.GSC_TOKENS) {
		const kvToken = await env.GSC_TOKENS.get('GOOGLE_ACCESS_TOKEN');
		accessToken = kvToken || undefined;
	}

	// If still no token, try to refresh
	if (!accessToken) {
		accessToken = await refreshAccessToken(env);
	} else {
		// Try to use existing token, refresh if it fails
		try {
			// Test token by making a simple API call
			const testResponse = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			});

			// If unauthorized, refresh token
			if (testResponse.status === 401) {
				accessToken = await refreshAccessToken(env);
			}
		} catch {
			// If test fails, try refreshing
			accessToken = await refreshAccessToken(env);
		}
	}

	return accessToken;
}

/**
 * Make authenticated request to Google Search Console API
 */
async function gscApiRequest(url: string, options: RequestInit = {}, env: Env): Promise<Response> {
	const accessToken = await getAccessToken(env);

	const response = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
			...options.headers,
		},
	});

	// If unauthorized, try refreshing token once
	if (response.status === 401) {
		const newAccessToken = await refreshAccessToken(env);
		return fetch(url, {
			...options,
			headers: {
				Authorization: `Bearer ${newAccessToken}`,
				'Content-Type': 'application/json',
				...options.headers,
			},
		});
	}

	return response;
}

/**
 * ============================================================================
 * TOOL DEFINITIONS - Tier 1: Site Management
 * ============================================================================
 */

const TOOLS: Tool[] = [
	{
		name: 'list_sites',
		description:
			'Retrieves all Google Search Console properties (websites) that the authenticated user has access to. Returns site URLs, permission levels, and verification status.',
		inputSchema: {
			type: 'object',
			properties: {},
			required: [],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const response = await gscApiRequest('https://www.googleapis.com/webmasters/v3/sites', { method: 'GET' }, env);

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`Failed to list sites: ${error}`);
			}

			const data = (await response.json()) as {
				siteEntry?: Array<{
					siteUrl: string;
					permissionLevel: string;
				}>;
			};

			const sites = data.siteEntry || [];

			if (sites.length === 0) {
				return {
					content: [
						{
							type: 'text',
							text: `Google Search Console Properties:

You have access to 0 properties.

No Search Console properties found. Please verify your OAuth credentials and ensure you have access to at least one property in Google Search Console.`,
						},
					],
				};
			}

			const formattedSites = sites
				.map((site: { siteUrl: string; permissionLevel: string }, index: number) => {
					const propertyType = site.siteUrl.startsWith('sc-domain:') ? 'Domain property' : 'URL-prefix property';

					const permissionLabel =
						site.permissionLevel === 'siteOwner'
							? 'Site Owner'
							: site.permissionLevel === 'siteFullUser'
							? 'Full User'
							: site.permissionLevel === 'siteRestrictedUser'
							? 'Restricted User'
							: site.permissionLevel;

					return `${index + 1}. ${site.siteUrl}
   Permission: ${permissionLabel}
   Type: ${propertyType}`;
				})
				.join('\n\n');

			return {
				content: [
					{
						type: 'text',
						text: `Google Search Console Properties:

You have access to ${sites.length} ${sites.length === 1 ? 'property' : 'properties'}:

${formattedSites}

Total: ${sites.length} ${sites.length === 1 ? 'property' : 'properties'}

Tip: Use get_site_details with a specific siteUrl to see verification status and additional information.`,
					},
				],
			};
		},
	},
	{
		name: 'get_site_details',
		description:
			'Retrieves detailed information about a specific Search Console property, including verification status and permission level.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'The site URL (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
			},
			required: ['siteUrl'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			if (!siteUrl) {
				throw new Error('siteUrl parameter is required');
			}

			const encodedSiteUrl = encodeURIComponent(siteUrl);
			const response = await gscApiRequest(`https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}`, { method: 'GET' }, env);

			if (!response.ok) {
				if (response.status === 404) {
					throw new Error(`Site not found: ${siteUrl}. Please verify the site URL and ensure you have access to this property.`);
				}
				const error = await response.text();
				throw new Error(`Failed to get site details: ${error}`);
			}

			const data = (await response.json()) as {
				siteUrl: string;
				permissionLevel: string;
			};

			const permissionLevel = data.permissionLevel;
			const propertyType = siteUrl.startsWith('sc-domain:') ? 'Domain property' : 'URL-prefix property';

			const accessLevelDescription =
				permissionLevel === 'siteOwner'
					? 'Full Owner - Can manage all aspects'
					: permissionLevel === 'siteFullUser'
					? 'Full User - Can view all data and take some actions'
					: permissionLevel === 'siteRestrictedUser'
					? 'Restricted User - Limited view access'
					: 'Unknown permission level';

			const accessIcon = permissionLevel === 'siteOwner' ? '✓' : '→';

			return {
				content: [
					{
						type: 'text',
						text: `Site Property Details:

Site URL: ${data.siteUrl}
Permission Level: ${permissionLevel}
Property Type: ${propertyType}

${accessIcon} Access Level: ${accessLevelDescription}

This property is properly configured and accessible.`,
					},
				],
			};
		},
	},
	{
		name: 'search_analytics',
		description:
			'Retrieves comprehensive search performance data from Google Search Console with support for up to 25,000 rows, advanced filtering including regex patterns, multiple dimensions, and automatic quick wins detection for SEO opportunities.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'Site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				startDate: {
					type: 'string',
					description: 'Start date in YYYY-MM-DD format',
				},
				endDate: {
					type: 'string',
					description: 'End date in YYYY-MM-DD format',
				},
				dimensions: {
					type: 'string',
					description:
						'Comma-separated list or JSON array of dimensions. Valid values: query, page, country, device, searchAppearance, date. Example: "query,page" or ["query","page"]',
				},
				type: {
					type: 'string',
					description: 'Search type. Valid values: web, image, video, news, discover, googleNews. Default: web',
				},
				aggregationType: {
					type: 'string',
					description: 'Aggregation method. Valid values: auto, byNewsShowcasePanel, byProperty, byPage. Default: auto',
				},
				rowLimit: {
					type: 'string',
					description: 'Maximum rows to return. Range: 1-25000. Default: 1000. Can be a number or string.',
				},
				startRow: {
					type: 'string',
					description: 'Starting row for pagination. Default: 0. Can be a number or string.',
				},
				dataState: {
					type: 'string',
					description: 'Data freshness. Valid values: all, final. Default: final',
				},
				pageFilter: {
					type: 'string',
					description: 'Filter by page URL. Use "regex:" prefix for regex patterns (e.g., "regex:.*blog.*")',
				},
				queryFilter: {
					type: 'string',
					description: 'Filter by search query. Use "regex:" prefix for regex patterns (e.g., "regex:(AI|machine learning)")',
				},
				countryFilter: {
					type: 'string',
					description: 'Filter by country ISO 3166-1 alpha-3 code (e.g., USA, CAN, GBR)',
				},
				deviceFilter: {
					type: 'string',
					description: 'Filter by device type. Valid values: DESKTOP, MOBILE, TABLET',
				},
				searchAppearanceFilter: {
					type: 'string',
					description: 'Filter by search feature (e.g., AMP_BLUE_LINK, AMP_TOP_STORIES)',
				},
				filterOperator: {
					type: 'string',
					description:
						'Operator for filters. Valid values: equals, contains, notEquals, notContains, includingRegex, excludingRegex. Default: equals',
				},
				detectQuickWins: {
					type: 'string',
					description:
						'Enable automatic detection of SEO optimization opportunities. Accepts: true, false, "true", "false". Default: false',
				},
				quickWinsConfig: {
					type: 'string',
					description: 'JSON string with quick wins configuration. Example: {"positionRange": [4, 20], "minImpressions": 100, "minCtr": 1}',
				},
			},
			required: ['siteUrl', 'startDate', 'endDate'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const startDate = args.startDate as string;
			const endDate = args.endDate as string;
			const dimensionsInput = args.dimensions;
			const type = (args.type as string) || 'web';
			const aggregationType = (args.aggregationType as string) || 'auto';
			const rowLimitInput = args.rowLimit;
			const startRowInput = args.startRow;
			const dataState = (args.dataState as string) || 'final';
			const pageFilter = args.pageFilter as string | undefined;
			const queryFilter = args.queryFilter as string | undefined;
			const countryFilter = args.countryFilter as string | undefined;
			const deviceFilter = args.deviceFilter as string | undefined;
			const searchAppearanceFilter = args.searchAppearanceFilter as string | undefined;
			const filterOperator = (args.filterOperator as string) || 'equals';
			const detectQuickWins =
				args.detectQuickWins === true || args.detectQuickWins === 'true' || (args.detectQuickWins as string) === 'true';
			const quickWinsConfigStr = args.quickWinsConfig as string | undefined;

			// Validate dates
			const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
			if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
				throw new Error('Dates must be in YYYY-MM-DD format');
			}

			// Validate date range
			const startDateObj = new Date(startDate);
			const endDateObj = new Date(endDate);
			if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
				throw new Error('Invalid date format. Dates must be valid YYYY-MM-DD dates.');
			}
			if (startDateObj > endDateObj) {
				throw new Error('startDate must be before or equal to endDate');
			}

			// Check date range is not too large (GSC API has limits)
			const daysDiff = Math.ceil((endDateObj.getTime() - startDateObj.getTime()) / (1000 * 60 * 60 * 24));
			if (daysDiff > 1095) {
				throw new Error('Date range cannot exceed 3 years (1095 days). Please use a smaller date range.');
			}

			// Parse dimensions - support both array and comma-separated string
			let dimensions: string[] = [];
			if (dimensionsInput) {
				if (Array.isArray(dimensionsInput)) {
					dimensions = dimensionsInput.map((d: unknown) => String(d).trim()).filter(Boolean) as string[];
				} else if (typeof dimensionsInput === 'string') {
					// Try to parse as JSON array first
					try {
						const parsed = JSON.parse(dimensionsInput);
						if (Array.isArray(parsed)) {
							dimensions = parsed.map((d) => String(d).trim()).filter(Boolean);
						} else {
							// Fall back to comma-separated
							dimensions = dimensionsInput
								.split(',')
								.map((d: string) => d.trim())
								.filter(Boolean) as string[];
						}
					} catch {
						// Not JSON, treat as comma-separated string
						dimensions = dimensionsInput
							.split(',')
							.map((d: string) => d.trim())
							.filter(Boolean) as string[];
					}
				}
			}

			// Validate dimensions
			const validDimensions: string[] = ['query', 'page', 'country', 'device', 'searchAppearance', 'date'];
			const invalidDimensions = dimensions.filter((d: string) => !validDimensions.includes(d));
			if (invalidDimensions.length > 0) {
				throw new Error(`Invalid dimensions: ${invalidDimensions.join(', ')}. Valid values: ${validDimensions.join(', ')}`);
			}

			// Parse rowLimit and startRow - support both number and string
			const rowLimit = typeof rowLimitInput === 'number' ? rowLimitInput : parseInt(String(rowLimitInput || '1000'), 10);
			const startRow = typeof startRowInput === 'number' ? startRowInput : parseInt(String(startRowInput || '0'), 10);

			// Validate rowLimit
			if (isNaN(rowLimit) || rowLimit < 1 || rowLimit > 25000) {
				throw new Error('rowLimit must be a number between 1 and 25000');
			}

			// Validate startRow
			if (isNaN(startRow) || startRow < 0) {
				throw new Error('startRow must be a non-negative number');
			}

			// Parse quick wins config
			let quickWinsConfig = {
				positionRange: [4, 20] as [number, number],
				minImpressions: 100,
				minCtr: 1,
			};
			if (quickWinsConfigStr) {
				try {
					const parsed = typeof quickWinsConfigStr === 'string' ? JSON.parse(quickWinsConfigStr) : quickWinsConfigStr;
					if (parsed.positionRange && Array.isArray(parsed.positionRange) && parsed.positionRange.length === 2) {
						quickWinsConfig.positionRange = [parsed.positionRange[0], parsed.positionRange[1]];
					}
					if (typeof parsed.minImpressions === 'number') {
						quickWinsConfig.minImpressions = parsed.minImpressions;
					}
					if (typeof parsed.minCtr === 'number') {
						quickWinsConfig.minCtr = parsed.minCtr;
					}
				} catch {
					// Invalid JSON, use defaults
				}
			}

			// Validate filter operator
			const validOperators: string[] = ['equals', 'contains', 'notEquals', 'notContains', 'includingRegex', 'excludingRegex'];
			if (!validOperators.includes(filterOperator)) {
				throw new Error(`Invalid filterOperator: ${filterOperator}. Valid values: ${validOperators.join(', ')}`);
			}

			// Build filter groups
			const dimensionFilterGroups: Array<{
				filters: Array<{
					dimension: string;
					operator: string;
					expression: string;
				}>;
			}> = [];

			// Helper to determine operator based on regex prefix and default operator
			const getOperator = (value: string, defaultOp: string): string => {
				if (value.startsWith('regex:')) {
					return defaultOp === 'equals' || defaultOp === 'contains' ? 'includingRegex' : 'excludingRegex';
				}
				return defaultOp;
			};

			// Helper to extract expression (remove regex: prefix if present)
			const getExpression = (value: string): string => {
				return value.startsWith('regex:') ? value.substring(6) : value;
			};

			if (pageFilter) {
				const operator = getOperator(pageFilter, filterOperator);
				dimensionFilterGroups.push({
					filters: [
						{
							dimension: 'page',
							operator,
							expression: getExpression(pageFilter),
						},
					],
				});
			}

			if (queryFilter) {
				const operator = getOperator(queryFilter, filterOperator);
				dimensionFilterGroups.push({
					filters: [
						{
							dimension: 'query',
							operator,
							expression: getExpression(queryFilter),
						},
					],
				});
			}

			if (countryFilter) {
				dimensionFilterGroups.push({
					filters: [
						{
							dimension: 'country',
							operator: filterOperator,
							expression: countryFilter,
						},
					],
				});
			}

			if (deviceFilter) {
				const validDevices: string[] = ['DESKTOP', 'MOBILE', 'TABLET'];
				if (!validDevices.includes(deviceFilter)) {
					throw new Error(`Invalid device filter: ${deviceFilter}. Valid values: ${validDevices.join(', ')}`);
				}
				dimensionFilterGroups.push({
					filters: [
						{
							dimension: 'device',
							operator: filterOperator,
							expression: deviceFilter,
						},
					],
				});
			}

			if (searchAppearanceFilter) {
				dimensionFilterGroups.push({
					filters: [
						{
							dimension: 'searchAppearance',
							operator: filterOperator,
							expression: searchAppearanceFilter,
						},
					],
				});
			}

			// Validate search type
			const validSearchTypes: string[] = ['web', 'image', 'video', 'news', 'discover', 'googleNews'];
			if (!validSearchTypes.includes(type)) {
				throw new Error(`Invalid search type: ${type}. Valid values: ${validSearchTypes.join(', ')}`);
			}

			// Validate aggregation type
			const validAggregationTypes: string[] = ['auto', 'byNewsShowcasePanel', 'byProperty', 'byPage'];
			if (!validAggregationTypes.includes(aggregationType)) {
				throw new Error(`Invalid aggregationType: ${aggregationType}. Valid values: ${validAggregationTypes.join(', ')}`);
			}

			// Validate data state
			if (dataState !== 'all' && dataState !== 'final') {
				throw new Error(`Invalid dataState: ${dataState}. Valid values: all, final`);
			}

			// Build request body
			const requestBody: Record<string, unknown> = {
				startDate,
				endDate,
				type,
				aggregationType,
				dataState,
				rowLimit: Math.min(Math.max(1, rowLimit), 25000),
				startRow: Math.max(0, startRow),
			};

			if (dimensions.length > 0) {
				requestBody.dimensions = dimensions;
			}

			if (dimensionFilterGroups.length > 0) {
				requestBody.dimensionFilterGroups = dimensionFilterGroups;
			}

			const encodedSiteUrl = encodeURIComponent(siteUrl);
			const response = await gscApiRequest(
				`https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`,
				{
					method: 'POST',
					body: JSON.stringify(requestBody),
				},
				env
			);

			if (!response.ok) {
				let errorMessage = `Failed to query search analytics`;
				try {
					const errorData = (await response.json()) as { error?: { message?: string; code?: number } };
					if (errorData.error?.message) {
						errorMessage = `${errorMessage}: ${errorData.error.message}`;
					} else {
						const errorText = await response.text();
						if (errorText) {
							errorMessage = `${errorMessage}: ${errorText}`;
						}
					}
				} catch {
					const errorText = await response.text();
					if (errorText) {
						errorMessage = `${errorMessage}: ${errorText}`;
					}
				}

				if (response.status === 400) {
					errorMessage = `${errorMessage} (Bad Request - check your parameters)`;
				} else if (response.status === 401) {
					errorMessage = `${errorMessage} (Unauthorized - check your OAuth credentials)`;
				} else if (response.status === 403) {
					errorMessage = `${errorMessage} (Forbidden - you may not have access to this site)`;
				} else if (response.status === 404) {
					errorMessage = `${errorMessage} (Site not found - verify the siteUrl parameter)`;
				}

				throw new Error(errorMessage);
			}

			const data = (await response.json()) as {
				rows?: Array<{
					keys: string[];
					clicks: number;
					impressions: number;
					ctr: number;
					position: number;
				}>;
			};

			const rows = data.rows || [];

			// Calculate aggregate metrics
			let totalClicks = 0;
			let totalImpressions = 0;
			let totalCtr = 0;
			let totalPosition = 0;

			rows.forEach((row: { clicks: number; impressions: number; ctr: number; position: number }) => {
				totalClicks += row.clicks;
				totalImpressions += row.impressions;
				totalCtr += row.ctr;
				totalPosition += row.position;
			});

			const avgCtr = rows.length > 0 ? totalCtr / rows.length : 0;
			const avgPosition = rows.length > 0 ? totalPosition / rows.length : 0;

			// Helper to extract dimension value from row keys
			const getDimensionValue = (row: { keys: string[] }, dimensionName: string): string => {
				const dimensionIndex = dimensions.indexOf(dimensionName);
				return dimensionIndex >= 0 && dimensionIndex < row.keys.length ? row.keys[dimensionIndex] : 'N/A';
			};

			// Get top performing queries
			const topQueries = rows
				.slice(0, 10)
				.map((row: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }) => {
					const query = getDimensionValue(row, 'query');
					const page = getDimensionValue(row, 'page');
					return {
						query,
						page,
						clicks: row.clicks,
						impressions: row.impressions,
						ctr: row.ctr,
						position: row.position,
					};
				});

			// Quick wins detection
			let quickWinsText = '';
			if (detectQuickWins) {
				const [minPosition, maxPosition] = quickWinsConfig.positionRange;
				const quickWins = rows
					.filter((row: { position: number; impressions: number; ctr: number; keys: string[] }) => {
						// Use configurable thresholds
						return (
							row.position >= minPosition &&
							row.position <= maxPosition &&
							row.impressions >= quickWinsConfig.minImpressions &&
							row.ctr <= quickWinsConfig.minCtr
						);
					})
					.slice(0, 10)
					.map((row: { position: number; impressions: number; ctr: number; clicks: number; keys: string[] }) => {
						const query = getDimensionValue(row, 'query');
						const page = getDimensionValue(row, 'page');
						const potentialClicks = Math.round(row.impressions * 0.05); // Estimate 5% CTR if ranking top 3
						const potentialIncrease = potentialClicks - row.clicks;
						const increasePercent = row.clicks > 0 ? (potentialIncrease / row.clicks) * 100 : 0;

						return {
							query,
							page,
							position: row.position,
							impressions: row.impressions,
							clicks: row.clicks,
							ctr: row.ctr,
							potentialClicks,
							potentialIncrease,
							increasePercent,
							opportunity: `Optimize title tag and meta description to improve CTR. Potential: +${potentialIncrease} clicks (+${increasePercent.toFixed(
								0
							)}%)`,
						};
					});

				if (quickWins.length > 0) {
					quickWinsText = `\n\nQuick Win Opportunities Detected:\n${quickWins
						.map(
							(qw: { query: string; page: string; position: number; impressions: number; ctr: number; opportunity: string }, i: number) =>
								`${i + 1}. "${qw.query}" (${qw.page})\n   Position: ${qw.position.toFixed(
									1
								)} | Impressions: ${qw.impressions.toLocaleString()}\n   Current CTR: ${qw.ctr.toFixed(2)}%\n   → ${qw.opportunity}`
						)
						.join('\n\n')}`;
				} else {
					quickWinsText = '\n\nQuick Win Opportunities Detected:\nNo quick win opportunities found with current criteria.';
				}
			}

			// Format top queries
			const topQueriesText = topQueries
				.map((q: { query: string; page: string; clicks: number; impressions: number; ctr: number; position: number }, i: number) => {
					const queryDisplay = q.query !== 'N/A' ? `"${q.query}"` : 'N/A';
					const pageDisplay = q.page !== 'N/A' ? q.page : 'N/A';
					return `${
						i + 1
					}. ${queryDisplay}\n   Page: ${pageDisplay}\n   Clicks: ${q.clicks.toLocaleString()} | Impressions: ${q.impressions.toLocaleString()}\n   CTR: ${q.ctr.toFixed(
						2
					)}% | Position: ${q.position.toFixed(1)}`;
				})
				.join('\n\n');

			const dimensionsDisplay = dimensions.length > 0 ? dimensions.join(', ') : 'none';
			const ctrIndicator = avgCtr > 5 ? '✓' : '⚠';
			const positionIndicator = avgPosition < 10 ? '✓' : '⚠';

			const insights = generateInsights({
				totalClicks,
				totalImpressions,
				avgCtr,
				avgPosition,
				rows,
			});

			const recommendations = generateRecommendations({
				avgCtr,
				avgPosition,
				totalClicks,
			});

			return {
				content: [
					{
						type: 'text',
						text: `Search Performance Summary:

Site: ${siteUrl}
Date Range: ${startDate} to ${endDate}
Dimensions: ${dimensionsDisplay}
Row Limit: ${rowLimit} (showing ${rows.length} rows)

Overall Metrics:
- Total Clicks: ${totalClicks.toLocaleString()}
- Total Impressions: ${totalImpressions.toLocaleString()}
- Average CTR: ${avgCtr.toFixed(2)}%
- Average Position: ${avgPosition.toFixed(1)}

Performance Indicators:
${ctrIndicator} Click-through rate is ${avgCtr > 5 ? 'healthy (above 5%)' : 'below industry average (5%)'}
${positionIndicator} Average position is ${avgPosition < 10 ? 'strong (first page)' : 'needs improvement (page 2+)'}

Top Performing Queries:
${topQueriesText}${quickWinsText}

Insights:
${insights}

Recommendations:
${recommendations}`,
					},
				],
			};
		},
	},
	/**
	 * ============================================================================
	 * TIER 2: URL & Sitemap Inspection
	 * ============================================================================
	 */
	{
		name: 'inspect_url',
		description:
			"Retrieves detailed indexing information for a specific URL, including whether it's indexed by Google, crawl status, mobile usability, and any indexing issues detected.",
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'The site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				inspectionUrl: {
					type: 'string',
					description: 'The full URL to inspect (e.g., "https://example.com/page")',
				},
				languageCode: {
					type: 'string',
					description: 'Language code for response. Default: "en-US"',
				},
			},
			required: ['siteUrl', 'inspectionUrl'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const inspectionUrl = args.inspectionUrl as string;
			const languageCode = (args.languageCode as string) || 'en-US';

			if (!siteUrl || !inspectionUrl) {
				throw new Error('siteUrl and inspectionUrl parameters are required');
			}

			// URL Inspection API uses v1, different base URL
			const requestBody = {
				inspectionUrl,
				siteUrl,
				languageCode,
			};

			const response = await gscApiRequest(
				'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
				{
					method: 'POST',
					body: JSON.stringify(requestBody),
				},
				env
			);

			if (!response.ok) {
				let errorMessage = 'Failed to inspect URL';
				try {
					const errorData = (await response.json()) as { error?: { message?: string } };
					if (errorData.error?.message) {
						errorMessage = `${errorMessage}: ${errorData.error.message}`;
					}
				} catch {
					const errorText = await response.text();
					if (errorText) {
						errorMessage = `${errorMessage}: ${errorText}`;
					}
				}
				throw new Error(errorMessage);
			}

			const data = (await response.json()) as {
				inspectionResult?: {
					indexStatusResult?: {
						verdict?: string;
						coverageState?: string;
						indexingState?: string;
						lastCrawlTime?: string;
						pageFetchState?: string;
						robotsTxtState?: string;
						googleCanonical?: string;
						userCanonical?: string;
						mobileUsabilityResult?: {
							verdict?: string;
							issues?: Array<{ issueType?: string; message?: string }>;
						};
						richResultsResult?: {
							verdict?: string;
							detectedItems?: Array<{ richResultType?: string }>;
						};
						inspectionResultLink?: string;
					};
				};
			};

			const result = data.inspectionResult?.indexStatusResult;
			if (!result) {
				throw new Error('No inspection result returned from API');
			}

			const verdict = result.verdict || 'UNKNOWN';
			const coverageState = result.coverageState || 'UNKNOWN';
			const indexingState = result.indexingState || 'UNKNOWN';
			const lastCrawlTime = result.lastCrawlTime || 'Never';
			const pageFetchState = result.pageFetchState || 'UNKNOWN';
			const robotsTxtState = result.robotsTxtState || 'UNKNOWN';
			const googleCanonical = result.googleCanonical || 'N/A';
			const userCanonical = result.userCanonical || 'N/A';
			const mobileVerdict = result.mobileUsabilityResult?.verdict || 'UNKNOWN';
			const mobileIssues = result.mobileUsabilityResult?.issues || [];
			const richResultsVerdict = result.richResultsResult?.verdict || 'UNKNOWN';
			const detectedItems = result.richResultsResult?.detectedItems || [];
			const inspectionResultLink = result.inspectionResultLink || 'N/A';

			const indexingAllowed = indexingState === 'INDEXING_ALLOWED';
			const robotsAllowed = robotsTxtState === 'ALLOWED';
			const pageFetchSuccessful = pageFetchState === 'SUCCESSFUL';

			const verdictIcon = verdict === 'PASS' ? '✓' : '❌';
			const mobileIcon = mobileVerdict === 'PASS' ? '✓ Passed' : mobileVerdict === 'FAIL' ? '❌ Failed' : '⚠ Neutral';
			const richResultsIcon =
				richResultsVerdict === 'PASS'
					? '✓ Valid structured data'
					: richResultsVerdict === 'FAIL'
					? '❌ Issues with structured data'
					: '- No rich results detected';

			const mobileIssuesText =
				mobileIssues.length > 0
					? `Issues detected:\n${mobileIssues
							.map((i: { issueType?: string; message?: string }) => `  - ${i.issueType || 'Unknown'}: ${i.message || 'No message'}`)
							.join('\n')}`
					: 'No mobile usability issues';

			const detectedItemsText =
				detectedItems.length > 0
					? `Detected items:\n${detectedItems.map((i: { richResultType?: string }) => `  - ${i.richResultType || 'Unknown'}`).join('\n')}`
					: '';

			const canonicalMatch = googleCanonical === userCanonical && googleCanonical !== 'N/A';

			return {
				content: [
					{
						type: 'text',
						text: `URL Inspection Results:

URL: ${inspectionUrl}
Site Property: ${siteUrl}
Last Crawled: ${lastCrawlTime}

Index Status:
${verdictIcon} Overall Verdict: ${verdict}
Coverage State: ${coverageState}

Crawling & Indexing:
${indexingAllowed ? '✓' : '❌'} Indexing: ${indexingState}
${robotsAllowed ? '✓' : '❌'} Robots.txt: ${robotsTxtState}
${pageFetchSuccessful ? '✓' : '❌'} Page Fetch: ${pageFetchState}

Canonical URLs:
- Google's Canonical: ${googleCanonical}
- User-Declared Canonical: ${userCanonical}
${canonicalMatch ? '✓ Canonicals match' : '⚠ Canonical mismatch detected'}

Mobile Usability:
${mobileIcon}
${mobileIssuesText}

Rich Results:
${richResultsIcon}
${detectedItemsText ? `${detectedItemsText}\n` : ''}
${
	verdict === 'PASS'
		? '✓ This URL is healthy and properly indexed by Google.'
		: '⚠ Action Required: Address the issues above to improve indexing.'
}

View full details in Search Console:
${inspectionResultLink}`,
					},
				],
			};
		},
	},
	{
		name: 'batch_inspect_urls',
		description:
			'Inspects multiple URLs at once and identifies common indexing patterns, issues, or opportunities across the batch. Useful for auditing important pages or identifying systemic issues.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'The site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				urls: {
					type: 'string',
					description:
						'JSON array of URLs to inspect (recommend max 20 per call due to rate limits). Example: ["https://example.com/page1", "https://example.com/page2"]',
				},
				languageCode: {
					type: 'string',
					description: 'Language code for response. Default: "en-US"',
				},
			},
			required: ['siteUrl', 'urls'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const urlsInput = args.urls;
			const languageCode = (args.languageCode as string) || 'en-US';

			if (!siteUrl) {
				throw new Error('siteUrl parameter is required');
			}

			// Parse URLs - support both array and JSON string
			let urls: string[] = [];
			if (Array.isArray(urlsInput)) {
				urls = urlsInput.map((u: unknown) => String(u).trim()).filter(Boolean) as string[];
			} else if (typeof urlsInput === 'string') {
				try {
					const parsed = JSON.parse(urlsInput);
					if (Array.isArray(parsed)) {
						urls = parsed.map((u: unknown) => String(u).trim()).filter(Boolean) as string[];
					} else {
						throw new Error('urls must be an array');
					}
				} catch {
					throw new Error('urls must be a JSON array string or array');
				}
			}

			if (urls.length === 0) {
				throw new Error('At least one URL is required');
			}

			if (urls.length > 20) {
				throw new Error('Maximum 20 URLs per batch inspection (rate limit)');
			}

			// Rate limit: ~600 calls/minute per property, add 100ms delay between calls
			const results: Array<{
				url: string;
				indexed: boolean;
				verdict: string;
				lastCrawlTime: string;
				issues: string[];
			}> = [];

			for (let i = 0; i < urls.length; i++) {
				const url = urls[i];
				try {
					const requestBody = {
						inspectionUrl: url,
						siteUrl,
						languageCode,
					};

					const response = await gscApiRequest(
						'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
						{
							method: 'POST',
							body: JSON.stringify(requestBody),
						},
						env
					);

					if (response.ok) {
						const data = (await response.json()) as {
							inspectionResult?: {
								indexStatusResult?: {
									verdict?: string;
									indexingState?: string;
									lastCrawlTime?: string;
									mobileUsabilityResult?: {
										verdict?: string;
										issues?: Array<{ issueType?: string }>;
									};
									richResultsResult?: {
										verdict?: string;
									};
								};
							};
						};

						const result = data.inspectionResult?.indexStatusResult;
						const verdict = result?.verdict || 'UNKNOWN';
						const indexingState = result?.indexingState || 'UNKNOWN';
						const indexed = indexingState === 'INDEXING_ALLOWED' && verdict === 'PASS';
						const lastCrawlTime = result?.lastCrawlTime || 'Never';

						const issues: string[] = [];
						if (verdict !== 'PASS') {
							issues.push(`Verdict: ${verdict}`);
						}
						if (indexingState !== 'INDEXING_ALLOWED') {
							issues.push(`Indexing: ${indexingState}`);
						}
						if (result?.mobileUsabilityResult?.verdict === 'FAIL') {
							issues.push(`Mobile usability issues (${result.mobileUsabilityResult.issues?.length || 0})`);
						}
						if (result?.richResultsResult?.verdict === 'FAIL') {
							issues.push('Rich results issues');
						}

						results.push({
							url,
							indexed,
							verdict,
							lastCrawlTime,
							issues,
						});
					} else {
						results.push({
							url,
							indexed: false,
							verdict: 'ERROR',
							lastCrawlTime: 'Never',
							issues: [`API Error: ${response.status}`],
						});
					}
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					results.push({
						url,
						indexed: false,
						verdict: 'ERROR',
						lastCrawlTime: 'Never',
						issues: [`Error: ${errorMessage}`],
					});
				}

				// Add delay between requests (except for last one)
				if (i < urls.length - 1) {
					await new Promise<void>((resolve: () => void) => setTimeout(resolve, 100));
				}
			}

			const totalInspected = results.length;
			const indexed = results.filter((r) => r.indexed).length;
			const notIndexed = totalInspected - indexed;
			const issuesCount = results.filter((r) => r.issues.length > 0).length;

			// Find common issues
			const issueCounts: Record<string, number> = {};
			results.forEach((r: { issues: string[] }) => {
				r.issues.forEach((issue: string) => {
					const issueType = issue.split(':')[0];
					issueCounts[issueType] = (issueCounts[issueType] || 0) + 1;
				});
			});

			const commonIssues = Object.entries(issueCounts)
				.filter(([_issue, count]) => count > 1)
				.map(([issue, count]) => `${issue} (${count} URLs)`)
				.slice(0, 5);

			const resultsText = results
				.map((r: { url: string; indexed: boolean; verdict: string; lastCrawlTime: string; issues: string[] }, i: number): string => {
					return `${i + 1}. ${r.url}
   Status: ${r.indexed ? '✓ Indexed' : '❌ Not Indexed'}
   Verdict: ${r.verdict}
   Last Crawled: ${r.lastCrawlTime}
   ${r.issues.length > 0 ? `Issues: ${r.issues.join(', ')}` : ''}`;
				})
				.join('\n\n');

			type BatchResult = { indexed: boolean; issues: string[] };
			const generateBatchRecommendations = (results: BatchResult[]): string => {
				const recommendations: string[] = [];
				const notIndexedCount = results.filter((r: BatchResult) => !r.indexed).length;
				if (notIndexedCount > 0) {
					recommendations.push(`- ${notIndexedCount} URLs are not indexed - review robots.txt and sitemap`);
				}
				const mobileIssues = results.filter((r: BatchResult) => r.issues.some((i: string) => i.includes('Mobile'))).length;
				if (mobileIssues > 0) {
					recommendations.push(`- ${mobileIssues} URLs have mobile usability issues - optimize for mobile`);
				}
				if (commonIssues.length > 0) {
					recommendations.push(`- Address common issues: ${commonIssues.join(', ')}`);
				}
				return recommendations.length > 0 ? recommendations.join('\n') : '- All URLs are healthy';
			};

			return {
				content: [
					{
						type: 'text',
						text: `Batch URL Inspection Results:

Site: ${siteUrl}
URLs Inspected: ${totalInspected}

Summary:
✓ Indexed: ${indexed} URLs
❌ Not Indexed: ${notIndexed} URLs
⚠ Issues: ${issuesCount} URLs

Detailed Results:

${resultsText}

Common Issues Found:
${commonIssues.length > 0 ? commonIssues.map((i) => `⚠ ${i}`).join('\n') : '✓ No common issues detected'}

Recommendations:
${generateBatchRecommendations(results)}`,
					},
				],
			};
		},
	},
	{
		name: 'list_sitemaps',
		description:
			'Retrieves all sitemaps submitted for a site, including their status, last submission date, and any warnings or errors detected during processing.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'The site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				sitemapIndex: {
					type: 'string',
					description: 'Optional: URL of sitemap index to list entries from',
				},
			},
			required: ['siteUrl'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const sitemapIndex = args.sitemapIndex as string | undefined;

			if (!siteUrl) {
				throw new Error('siteUrl parameter is required');
			}

			const encodedSiteUrl = encodeURIComponent(siteUrl);
			let url = `https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/sitemaps`;
			if (sitemapIndex) {
				url += `?sitemapIndex=${encodeURIComponent(sitemapIndex)}`;
			}

			const response = await gscApiRequest(url, { method: 'GET' }, env);

			if (!response.ok) {
				let errorMessage = 'Failed to list sitemaps';
				try {
					const errorData = (await response.json()) as { error?: { message?: string } };
					if (errorData.error?.message) {
						errorMessage = `${errorMessage}: ${errorData.error.message}`;
					}
				} catch {
					const errorText = await response.text();
					if (errorText) {
						errorMessage = `${errorMessage}: ${errorText}`;
					}
				}
				throw new Error(errorMessage);
			}

			const data = (await response.json()) as {
				sitemap?: Array<{
					path?: string;
					lastSubmitted?: string;
					lastDownloaded?: string;
					type?: string;
					contents?: Array<{
						type?: string;
						submitted?: number;
						indexed?: number;
					}>;
					isPending?: boolean;
					isSitemapsIndex?: boolean;
					errors?: number;
					warnings?: number;
				}>;
			};

			const sitemaps = data.sitemap || [];

			if (sitemaps.length === 0) {
				return {
					content: [
						{
							type: 'text',
							text: `Sitemaps for ${siteUrl}:

Total Sitemaps: 0

No sitemaps found for this site. Submit sitemaps in Google Search Console to help Google discover and index your pages.`,
						},
					],
				};
			}

			// Calculate totals
			let totalSubmitted = 0;
			let totalIndexed = 0;
			let hasErrors = false;

			const sitemapsText = sitemaps
				.map(
					(
						s: {
							path?: string;
							type?: string;
							lastSubmitted?: string;
							isPending?: boolean;
							isSitemapsIndex?: boolean;
							errors?: number;
							warnings?: number;
							contents?: Array<{ type?: string; submitted?: number; indexed?: number }>;
						},
						i: number
					) => {
						const path = s.path || 'N/A';
						const type = s.type || 'Unknown';
						const lastSubmitted = s.lastSubmitted || 'Never';
						const isPending = s.isPending || false;
						const isSitemapsIndex = s.isSitemapsIndex || false;
						const errors = s.errors || 0;
						const warnings = s.warnings || 0;
						const contents = s.contents || [];

						if (errors > 0) {
							hasErrors = true;
						}

						let contentStats = '';
						if (contents.length > 0) {
							contentStats = contents
								.map((c: { type?: string; submitted?: number; indexed?: number }) => {
									const submitted = c.submitted || 0;
									const indexed = c.indexed || 0;
									const rate = submitted > 0 ? ((indexed / submitted) * 100).toFixed(1) : '0.0';
									totalSubmitted += submitted;
									totalIndexed += indexed;
									return `   - ${(
										c.type || 'Unknown'
									).toUpperCase()}: ${submitted.toLocaleString()} submitted, ${indexed.toLocaleString()} indexed (${rate}%)`;
								})
								.join('\n');
						}

						return `${i + 1}. ${path}
   Type: ${type}
   Last Submitted: ${lastSubmitted}
   Status: ${isPending ? '⏳ Pending' : '✓ Processed'}
   ${isSitemapsIndex ? '📑 Sitemap Index' : ''}

   Content Statistics:
${contentStats || '   No content statistics available'}

   Issues:
   ${errors > 0 ? `❌ ${errors} errors` : '✓ No errors'}
   ${warnings > 0 ? `⚠ ${warnings} warnings` : '✓ No warnings'}`;
					}
				)
				.join('\n\n');

			const indexRate = totalSubmitted > 0 ? ((totalIndexed / totalSubmitted) * 100).toFixed(1) : '0.0';

			return {
				content: [
					{
						type: 'text',
						text: `Sitemaps for ${siteUrl}:

Total Sitemaps: ${sitemaps.length}

${sitemapsText}

Summary:
- Total URLs Submitted: ${totalSubmitted.toLocaleString()}
- Total URLs Indexed: ${totalIndexed.toLocaleString()}
- Index Rate: ${indexRate}%

${hasErrors ? '⚠ Some sitemaps have errors - use get_sitemap_details for more information' : '✓ All sitemaps are healthy'}

Tip: Use get_sitemap_details with a specific sitemap path to see detailed error information.`,
					},
				],
			};
		},
	},
	{
		name: 'get_sitemap_details',
		description:
			'Retrieves detailed information about a specific sitemap, including submission status, processing errors, warnings, and statistics on submitted vs indexed URLs.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'The site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				feedpath: {
					type: 'string',
					description: 'The sitemap URL (e.g., "https://example.com/sitemap.xml")',
				},
			},
			required: ['siteUrl', 'feedpath'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const feedpath = args.feedpath as string;

			if (!siteUrl || !feedpath) {
				throw new Error('siteUrl and feedpath parameters are required');
			}

			const encodedSiteUrl = encodeURIComponent(siteUrl);
			const encodedFeedpath = encodeURIComponent(feedpath);
			const url = `https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/sitemaps/${encodedFeedpath}`;

			const response = await gscApiRequest(url, { method: 'GET' }, env);

			if (!response.ok) {
				if (response.status === 404) {
					throw new Error(`Sitemap not found: ${feedpath}. Please verify the sitemap path and ensure it exists for this site.`);
				}
				let errorMessage = 'Failed to get sitemap details';
				try {
					const errorData = (await response.json()) as { error?: { message?: string } };
					if (errorData.error?.message) {
						errorMessage = `${errorMessage}: ${errorData.error.message}`;
					}
				} catch {
					const errorText = await response.text();
					if (errorText) {
						errorMessage = `${errorMessage}: ${errorText}`;
					}
				}
				throw new Error(errorMessage);
			}

			const data = (await response.json()) as {
				path?: string;
				lastSubmitted?: string;
				lastDownloaded?: string;
				type?: string;
				contents?: Array<{
					type?: string;
					submitted?: number;
					indexed?: number;
				}>;
				isPending?: boolean;
				isSitemapsIndex?: boolean;
				errors?: number;
				warnings?: number;
			};

			const path = data.path || feedpath;
			const type = data.type || 'Unknown';
			const isPending = data.isPending || false;
			const isSitemapsIndex = data.isSitemapsIndex || false;
			const lastSubmitted = data.lastSubmitted || 'Never';
			const lastDownloaded = data.lastDownloaded || 'Never';
			const errors = data.errors || 0;
			const warnings = data.warnings || 0;
			const contents = data.contents || [];

			let totalSubmitted = 0;
			let totalIndexed = 0;

			const contentsText = contents
				.map((c: { type?: string; submitted?: number; indexed?: number }) => {
					const submitted = c.submitted || 0;
					const indexed = c.indexed || 0;
					const rate = submitted > 0 ? ((indexed / submitted) * 100).toFixed(1) : '0.0';
					totalSubmitted += submitted;
					totalIndexed += indexed;
					return `- ${(c.type || 'Unknown').toUpperCase()}:
  Submitted: ${submitted.toLocaleString()} URLs
  Indexed: ${indexed.toLocaleString()} URLs
  Index Rate: ${rate}%`;
				})
				.join('\n');

			const indexRate = totalSubmitted > 0 ? ((totalIndexed / totalSubmitted) * 100).toFixed(1) : '0.0';

			return {
				content: [
					{
						type: 'text',
						text: `Sitemap Details:

Path: ${path}
Site: ${siteUrl}

Status:
Type: ${type}
${isPending ? '⏳ Status: Pending processing' : '✓ Status: Processed'}
${isSitemapsIndex ? '📑 This is a Sitemap Index' : ''}

Timeline:
- Last Submitted: ${lastSubmitted}
- Last Downloaded: ${lastDownloaded}

Content Statistics:
${contentsText || 'No content statistics available'}

Issues:
${errors > 0 ? `❌ Errors: ${errors}` : '✓ No errors'}
${warnings > 0 ? `⚠ Warnings: ${warnings}` : '✓ No warnings'}

${
	errors === 0 && warnings === 0
		? '✓ This sitemap is healthy and properly configured.'
		: `⚠ Action Required: ${errors > 0 ? `Fix ${errors} errors` : ''} ${warnings > 0 ? `Review ${warnings} warnings` : ''}`
}

Index Coverage: ${indexRate}%
${
	totalIndexed === totalSubmitted ? '✓ All URLs are indexed' : `⚠ ${(totalSubmitted - totalIndexed).toLocaleString()} URLs not yet indexed`
}`,
					},
				],
			};
		},
	},
	/**
	 * ============================================================================
	 * TIER 3: Advanced Analytics
	 * ============================================================================
	 */
	{
		name: 'compare_periods',
		description:
			'Compares search performance between two time periods to identify which queries improved, declined, or remained stable. Useful for measuring impact of SEO changes or content updates.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'Site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				period1StartDate: {
					type: 'string',
					description: 'First period start date in YYYY-MM-DD format',
				},
				period1EndDate: {
					type: 'string',
					description: 'First period end date in YYYY-MM-DD format',
				},
				period2StartDate: {
					type: 'string',
					description: 'Second period start date in YYYY-MM-DD format',
				},
				period2EndDate: {
					type: 'string',
					description: 'Second period end date in YYYY-MM-DD format',
				},
				dimensions: {
					type: 'string',
					description:
						'Comma-separated list or JSON array of dimensions to compare. Default: ["query"]. Valid values: query, page, country, device',
				},
				metric: {
					type: 'string',
					description: 'Metric to compare. Valid values: clicks, impressions, ctr, position. Default: clicks',
				},
			},
			required: ['siteUrl', 'period1StartDate', 'period1EndDate', 'period2StartDate', 'period2EndDate'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const period1StartDate = args.period1StartDate as string;
			const period1EndDate = args.period1EndDate as string;
			const period2StartDate = args.period2StartDate as string;
			const period2EndDate = args.period2EndDate as string;
			const dimensionsInput = args.dimensions;
			const metric = (args.metric as string) || 'clicks';

			// Validate dates
			const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
			if (
				!dateRegex.test(period1StartDate) ||
				!dateRegex.test(period1EndDate) ||
				!dateRegex.test(period2StartDate) ||
				!dateRegex.test(period2EndDate)
			) {
				throw new Error('All dates must be in YYYY-MM-DD format');
			}

			// Parse dimensions
			let dimensions: string[] = ['query'];
			if (dimensionsInput) {
				if (Array.isArray(dimensionsInput)) {
					dimensions = dimensionsInput.map((d: unknown) => String(d).trim()).filter(Boolean) as string[];
				} else if (typeof dimensionsInput === 'string') {
					try {
						const parsed = JSON.parse(dimensionsInput);
						if (Array.isArray(parsed)) {
							dimensions = parsed.map((d: unknown) => String(d).trim()).filter(Boolean) as string[];
						} else {
							dimensions = dimensionsInput
								.split(',')
								.map((d: string) => d.trim())
								.filter(Boolean) as string[];
						}
					} catch {
						dimensions = dimensionsInput
							.split(',')
							.map((d: string) => d.trim())
							.filter(Boolean) as string[];
					}
				}
			}

			// Validate metric
			const validMetrics: string[] = ['clicks', 'impressions', 'ctr', 'position'];
			if (!validMetrics.includes(metric)) {
				throw new Error(`Invalid metric: ${metric}. Valid values: ${validMetrics.join(', ')}`);
			}

			// Call search_analytics for both periods
			const getPeriodData = async (startDate: string, endDate: string) => {
				const requestBody = {
					startDate,
					endDate,
					dimensions: dimensions.length > 0 ? dimensions : ['query'],
					rowLimit: 25000,
					startRow: 0,
					dataState: 'final',
				};

				const encodedSiteUrl = encodeURIComponent(siteUrl);
				const response = await gscApiRequest(
					`https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`,
					{
						method: 'POST',
						body: JSON.stringify(requestBody),
					},
					env
				);

				if (!response.ok) {
					throw new Error(`Failed to fetch period data: ${response.status}`);
				}

				const data = (await response.json()) as {
					rows?: Array<{
						keys: string[];
						clicks: number;
						impressions: number;
						ctr: number;
						position: number;
					}>;
				};

				return data.rows || [];
			};

			const [period1Rows, period2Rows] = await Promise.all([
				getPeriodData(period1StartDate, period1EndDate),
				getPeriodData(period2StartDate, period2EndDate),
			]);

			// Create maps for easy lookup by dimension keys
			const period1Map = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
			const period2Map = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();

			period1Rows.forEach((row: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }) => {
				const key = row.keys.join('|');
				period1Map.set(key, {
					clicks: row.clicks,
					impressions: row.impressions,
					ctr: row.ctr,
					position: row.position,
				});
			});

			period2Rows.forEach((row: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }) => {
				const key = row.keys.join('|');
				period2Map.set(key, {
					clicks: row.clicks,
					impressions: row.impressions,
					ctr: row.ctr,
					position: row.position,
				});
			});

			// Calculate aggregate metrics for each period
			const period1Clicks = period1Rows.reduce((sum, r) => sum + r.clicks, 0);
			const period1Impressions = period1Rows.reduce((sum, r) => sum + r.impressions, 0);
			const period1Ctr = period1Rows.length > 0 ? period1Rows.reduce((sum, r) => sum + r.ctr, 0) / period1Rows.length : 0;
			const period1Position = period1Rows.length > 0 ? period1Rows.reduce((sum, r) => sum + r.position, 0) / period1Rows.length : 0;

			const period2Clicks = period2Rows.reduce((sum, r) => sum + r.clicks, 0);
			const period2Impressions = period2Rows.reduce((sum, r) => sum + r.impressions, 0);
			const period2Ctr = period2Rows.length > 0 ? period2Rows.reduce((sum, r) => sum + r.ctr, 0) / period2Rows.length : 0;
			const period2Position = period2Rows.length > 0 ? period2Rows.reduce((sum, r) => sum + r.position, 0) / period2Rows.length : 0;

			// Calculate changes
			const clicksChange = period2Clicks - period1Clicks;
			const clicksChangePercent = period1Clicks > 0 ? (clicksChange / period1Clicks) * 100 : 0;
			const impressionsChange = period2Impressions - period1Impressions;
			const impressionsChangePercent = period1Impressions > 0 ? (impressionsChange / period1Impressions) * 100 : 0;
			const ctrChange = period2Ctr - period1Ctr;
			const positionChange = period2Position - period1Position;

			// Compare individual items
			const comparisons: Array<{
				key: string;
				keys: string[];
				period1Value: number;
				period2Value: number;
				change: number;
				changePercent: number;
			}> = [];

			// Get all unique keys
			const allKeys = new Set([...period1Map.keys(), ...period2Map.keys()]);

			allKeys.forEach((key) => {
				const p1 = period1Map.get(key) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
				const p2 = period2Map.get(key) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };

				let period1Value: number;
				let period2Value: number;

				if (metric === 'clicks') {
					period1Value = p1.clicks;
					period2Value = p2.clicks;
				} else if (metric === 'impressions') {
					period1Value = p1.impressions;
					period2Value = p2.impressions;
				} else if (metric === 'ctr') {
					period1Value = p1.ctr;
					period2Value = p2.ctr;
				} else {
					period1Value = p1.position;
					period2Value = p2.position;
				}

				const change = period2Value - period1Value;
				const changePercent = period1Value > 0 ? (change / period1Value) * 100 : period2Value > 0 ? 100 : 0;

				comparisons.push({
					key,
					keys: key.split('|'),
					period1Value,
					period2Value,
					change,
					changePercent,
				});
			});

			// Sort by change magnitude
			comparisons.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

			// Separate into improved, declined, new, and lost
			const improved = comparisons.filter((c) => {
				if (metric === 'position') {
					return c.change < 0; // Lower position is better
				}
				return c.change > 0 && c.period1Value > 0;
			});

			const declined = comparisons.filter((c) => {
				if (metric === 'position') {
					return c.change > 0; // Higher position is worse
				}
				return c.change < 0 && c.period1Value > 0;
			});

			const newItems = comparisons.filter((c) => c.period1Value === 0 && c.period2Value > 0);
			const lostItems = comparisons.filter((c) => c.period1Value > 0 && c.period2Value === 0);

			// Format dimension display
			const formatDimensionValue = (keys: string[], index: number): string => {
				return index < keys.length ? keys[index] : 'N/A';
			};

			const formatItem = (item: (typeof comparisons)[0], label: string) => {
				const dimValues = dimensions.map((d, i) => `${d}: ${formatDimensionValue(item.keys, i)}`).join(', ');
				return `${label}
   ${dimValues}
   Period 1: ${item.period1Value.toLocaleString()} ${metric}
   Period 2: ${item.period2Value.toLocaleString()} ${metric}
   Change: ${item.change >= 0 ? '+' : ''}${item.change.toLocaleString()} (${item.changePercent >= 0 ? '+' : ''}${item.changePercent.toFixed(
					1
				)}%)`;
			};

			const generateComparisonInsights = (): string => {
				const insights: string[] = [];
				if (clicksChangePercent > 20) {
					insights.push(`📈 Significant growth: Clicks increased by ${clicksChangePercent.toFixed(1)}%`);
				} else if (clicksChangePercent < -20) {
					insights.push(`📉 Significant decline: Clicks decreased by ${Math.abs(clicksChangePercent).toFixed(1)}%`);
				}
				if (positionChange < -2) {
					insights.push(`✓ Average position improved by ${Math.abs(positionChange).toFixed(1)} positions`);
				} else if (positionChange > 2) {
					insights.push(`⚠ Average position declined by ${positionChange.toFixed(1)} positions`);
				}
				if (newItems.length > improved.length) {
					insights.push(`💡 More new items (${newItems.length}) than improved items (${improved.length}) - expanding reach`);
				}
				return insights.length > 0 ? insights.join('\n') : 'Performance is relatively stable between periods';
			};

			const generateComparisonRecommendations = (): string => {
				const recommendations: string[] = [];
				if (declined.length > improved.length) {
					recommendations.push('- More items declined than improved - review content strategy');
				}
				if (positionChange > 0) {
					recommendations.push('- Average position declined - focus on content quality and backlinks');
				}
				if (ctrChange < 0) {
					recommendations.push('- CTR decreased - optimize title tags and meta descriptions');
				}
				if (newItems.length > 0) {
					recommendations.push(`- ${newItems.length} new items appeared - capitalize on these opportunities`);
				}
				return recommendations.length > 0 ? recommendations.join('\n') : '- Continue current strategy';
			};

			return {
				content: [
					{
						type: 'text',
						text: `Period Comparison Analysis:

Site: ${siteUrl}

Period 1: ${period1StartDate} to ${period1EndDate}
- Total Clicks: ${period1Clicks.toLocaleString()}
- Total Impressions: ${period1Impressions.toLocaleString()}
- Average CTR: ${period1Ctr.toFixed(2)}%
- Average Position: ${period1Position.toFixed(1)}

Period 2: ${period2StartDate} to ${period2EndDate}
- Total Clicks: ${period2Clicks.toLocaleString()}
- Total Impressions: ${period2Impressions.toLocaleString()}
- Average CTR: ${period2Ctr.toFixed(2)}%
- Average Position: ${period2Position.toFixed(1)}

Overall Change:
${clicksChange >= 0 ? '📈' : '📉'} Clicks: ${clicksChange >= 0 ? '+' : ''}${clicksChange.toLocaleString()} (${
							clicksChangePercent >= 0 ? '+' : ''
						}${clicksChangePercent.toFixed(1)}%)
${impressionsChange >= 0 ? '📈' : '📉'} Impressions: ${impressionsChange >= 0 ? '+' : ''}${impressionsChange.toLocaleString()} (${
							impressionsChangePercent >= 0 ? '+' : ''
						}${impressionsChangePercent.toFixed(1)}%)
${ctrChange >= 0 ? '📈' : '📉'} CTR: ${ctrChange >= 0 ? '+' : ''}${ctrChange.toFixed(2)}%
${positionChange <= 0 ? '📈' : '📉'} Position: ${positionChange <= 0 ? '+' : ''}${Math.abs(positionChange).toFixed(1)} ${
							positionChange <= 0 ? '(improved)' : '(declined)'
						}

Top Improved Items:
${improved
	.slice(0, 5)
	.map((item, i) => `${i + 1}. ${formatItem(item, formatDimensionValue(item.keys, 0))}`)
	.join('\n\n')}

Top Declined Items:
${declined
	.slice(0, 5)
	.map((item, i) => `${i + 1}. ${formatItem(item, formatDimensionValue(item.keys, 0))}`)
	.join('\n\n')}

New Items (appeared in Period 2):
${newItems
	.slice(0, 5)
	.map((item, i) => `${i + 1}. ${formatDimensionValue(item.keys, 0)} - ${item.period2Value.toLocaleString()} ${metric}`)
	.join('\n')}

Lost Items (disappeared in Period 2):
${lostItems
	.slice(0, 5)
	.map((item, i) => `${i + 1}. ${formatDimensionValue(item.keys, 0)} - was ${item.period1Value.toLocaleString()} ${metric}`)
	.join('\n')}

Insights:
${generateComparisonInsights()}

Recommendations:
${generateComparisonRecommendations()}`,
					},
				],
			};
		},
	},
	{
		name: 'find_keyword_opportunities',
		description:
			'Identifies search queries where the site is ranking on positions 4-20 (page 1-2) with high impressions but low clicks. These represent "quick win" opportunities where small improvements could significantly increase traffic.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'Site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				startDate: {
					type: 'string',
					description: 'Start date in YYYY-MM-DD format',
				},
				endDate: {
					type: 'string',
					description: 'End date in YYYY-MM-DD format',
				},
				minPosition: {
					type: 'string',
					description: 'Minimum position to consider. Default: 4',
				},
				maxPosition: {
					type: 'string',
					description: 'Maximum position to consider. Default: 20',
				},
				minImpressions: {
					type: 'string',
					description: 'Minimum impressions threshold. Default: 100',
				},
				maxCtr: {
					type: 'string',
					description: 'Maximum CTR percentage to flag. Default: 3',
				},
			},
			required: ['siteUrl', 'startDate', 'endDate'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const startDate = args.startDate as string;
			const endDate = args.endDate as string;
			const minPosition = parseInt(String(args.minPosition || '4'), 10);
			const maxPosition = parseInt(String(args.maxPosition || '20'), 10);
			const minImpressions = parseInt(String(args.minImpressions || '100'), 10);
			const maxCtr = parseFloat(String(args.maxCtr || '3'));

			// Validate dates
			const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
			if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
				throw new Error('Dates must be in YYYY-MM-DD format');
			}

			// Get search analytics data with query and page dimensions
			const requestBody = {
				startDate,
				endDate,
				dimensions: ['query', 'page'],
				rowLimit: 25000,
				startRow: 0,
				dataState: 'final',
			};

			const encodedSiteUrl = encodeURIComponent(siteUrl);
			const response = await gscApiRequest(
				`https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`,
				{
					method: 'POST',
					body: JSON.stringify(requestBody),
				},
				env
			);

			if (!response.ok) {
				throw new Error(`Failed to fetch search analytics: ${response.status}`);
			}

			const data = (await response.json()) as {
				rows?: Array<{
					keys: string[];
					clicks: number;
					impressions: number;
					ctr: number;
					position: number;
				}>;
			};

			const rows = data.rows || [];

			// Filter for opportunities
			const opportunities = rows
				.filter((row: { position: number; impressions: number; ctr: number; keys: string[] }) => {
					return row.position >= minPosition && row.position <= maxPosition && row.impressions >= minImpressions && row.ctr <= maxCtr;
				})
				.sort((a: { impressions: number }, b: { impressions: number }) => b.impressions - a.impressions)
				.slice(0, 10)
				.map((row: { keys: string[]; position: number; impressions: number; clicks: number; ctr: number }) => {
					const query = row.keys[0] || 'N/A';
					const page = row.keys[1] || 'N/A';
					const currentPosition = row.position;
					const impressions = row.impressions;
					const clicks = row.clicks;
					const ctr = row.ctr;

					// Estimate potential clicks if ranking #1-3 (assume 5% CTR)
					const potentialClicks = Math.round(impressions * 0.05);
					const potentialIncrease = potentialClicks - clicks;
					const increasePercent = clicks > 0 ? (potentialIncrease / clicks) * 100 : 0;

					// Generate recommendation
					let recommendation = 'Optimize title tag and meta description to improve CTR';
					if (currentPosition > 10) {
						recommendation += '. Improve content quality to push ranking to page 1';
					} else if (currentPosition > 7) {
						recommendation += '. Enhance content depth and internal linking';
					}

					return {
						query,
						page,
						currentPosition,
						impressions,
						clicks,
						ctr,
						potentialClicks,
						potentialIncrease,
						increasePercent,
						recommendation,
					};
				});

			const opportunityCount = opportunities.length;
			const totalImpressions = opportunities.reduce((sum, o) => sum + o.impressions, 0);
			const potentialClicks = opportunities.reduce((sum, o) => sum + o.potentialIncrease, 0);
			const top10Potential = opportunities.slice(0, 10).reduce((sum, o) => sum + o.potentialIncrease, 0);

			const opportunitiesText = opportunities
				.map(
					(
						opp: {
							query: string;
							page: string;
							currentPosition: number;
							impressions: number;
							clicks: number;
							ctr: number;
							potentialClicks: number;
							potentialIncrease: number;
							increasePercent: number;
							recommendation: string;
						},
						i: number
					) => {
						return `${i + 1}. "${opp.query}"
   Page: ${opp.page}

   Current Performance:
   - Position: ${opp.currentPosition.toFixed(1)}
   - Impressions: ${opp.impressions.toLocaleString()}
   - Clicks: ${opp.clicks}
   - CTR: ${opp.ctr.toFixed(2)}%

   Potential Impact:
   - Estimated clicks if ranking #1-3: ~${opp.potentialClicks}
   - Potential increase: +${opp.potentialIncrease} clicks (+${opp.increasePercent.toFixed(0)}%)

   → Recommendation: ${opp.recommendation}`;
					}
				)
				.join('\n\n');

			return {
				content: [
					{
						type: 'text',
						text: `Keyword Ranking Opportunities:

Site: ${siteUrl}
Date Range: ${startDate} to ${endDate}
Position Range: ${minPosition} - ${maxPosition}

Summary:
✓ Found ${opportunityCount} quick win opportunities
📊 Total impressions from these queries: ${totalImpressions.toLocaleString()}
💰 Potential traffic increase: ~${potentialClicks.toLocaleString()} additional clicks/month

Top Opportunities:

${opportunitiesText}

Strategy Overview:
These queries are already ranking on page 1-2 with high visibility but low clicks.
Small improvements could push them into top 3 positions and significantly increase traffic.

Recommended Actions:
1. Content Optimization: Update these pages with fresh, comprehensive content
2. Title Tags: Improve click-worthiness with compelling, keyword-rich titles
3. Meta Descriptions: Write persuasive descriptions to increase CTR
4. Internal Linking: Add contextual links from related high-authority pages
5. User Experience: Improve page speed and mobile usability
6. Featured Snippets: Optimize content to capture position zero

Expected ROI:
By targeting just the top 10 opportunities, you could potentially gain ${top10Potential.toLocaleString()}
additional monthly clicks with minimal effort compared to ranking for new keywords.`,
					},
				],
			};
		},
	},
	{
		name: 'get_device_breakdown',
		description:
			'Analyzes search performance across different device types (desktop, mobile, tablet) to identify device-specific optimization opportunities or issues.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'Site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				startDate: {
					type: 'string',
					description: 'Start date in YYYY-MM-DD format',
				},
				endDate: {
					type: 'string',
					description: 'End date in YYYY-MM-DD format',
				},
				additionalDimension: {
					type: 'string',
					description: 'Additional dimension to break down by (e.g., "query", "page"). Default: none',
				},
			},
			required: ['siteUrl', 'startDate', 'endDate'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const startDate = args.startDate as string;
			const endDate = args.endDate as string;
			const additionalDimension = args.additionalDimension as string | undefined;

			// Validate dates
			const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
			if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
				throw new Error('Dates must be in YYYY-MM-DD format');
			}

			// Build dimensions
			const dimensions = additionalDimension ? ['device', additionalDimension] : ['device'];

			// Get search analytics data
			const requestBody = {
				startDate,
				endDate,
				dimensions,
				rowLimit: 25000,
				startRow: 0,
				dataState: 'final',
			};

			const encodedSiteUrl = encodeURIComponent(siteUrl);
			const response = await gscApiRequest(
				`https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`,
				{
					method: 'POST',
					body: JSON.stringify(requestBody),
				},
				env
			);

			if (!response.ok) {
				throw new Error(`Failed to fetch search analytics: ${response.status}`);
			}

			const data = (await response.json()) as {
				rows?: Array<{
					keys: string[];
					clicks: number;
					impressions: number;
					ctr: number;
					position: number;
				}>;
			};

			const rows = data.rows || [];

			// Aggregate by device
			const deviceData: Record<string, { clicks: number; impressions: number; ctr: number; position: number; count: number }> = {};

			rows.forEach((row: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }) => {
				const device = row.keys[0] || 'UNKNOWN';
				if (!deviceData[device]) {
					deviceData[device] = { clicks: 0, impressions: 0, ctr: 0, position: 0, count: 0 };
				}
				deviceData[device].clicks += row.clicks;
				deviceData[device].impressions += row.impressions;
				deviceData[device].ctr += row.ctr;
				deviceData[device].position += row.position;
				deviceData[device].count += 1;
			});

			// Calculate totals and averages
			const totalClicks = Object.values(deviceData).reduce((sum, d) => sum + d.clicks, 0);
			const totalImpressions = Object.values(deviceData).reduce((sum, d) => sum + d.impressions, 0);

			const mobile = deviceData['MOBILE'] || { clicks: 0, impressions: 0, ctr: 0, position: 0, count: 0 };
			const desktop = deviceData['DESKTOP'] || { clicks: 0, impressions: 0, ctr: 0, position: 0, count: 0 };
			const tablet = deviceData['TABLET'] || { clicks: 0, impressions: 0, ctr: 0, position: 0, count: 0 };

			const mobileClicks = mobile.clicks;
			const mobileImpressions = mobile.impressions;
			const mobileCtr = mobile.count > 0 ? mobile.ctr / mobile.count : 0;
			const mobilePosition = mobile.count > 0 ? mobile.position / mobile.count : 0;
			const mobilePercent = totalClicks > 0 ? (mobileClicks / totalClicks) * 100 : 0;

			const desktopClicks = desktop.clicks;
			const desktopImpressions = desktop.impressions;
			const desktopCtr = desktop.count > 0 ? desktop.ctr / desktop.count : 0;
			const desktopPosition = desktop.count > 0 ? desktop.position / desktop.count : 0;
			const desktopPercent = totalClicks > 0 ? (desktopClicks / totalClicks) * 100 : 0;

			const tabletClicks = tablet.clicks;
			const tabletImpressions = tablet.impressions;
			const tabletCtr = tablet.count > 0 ? tablet.ctr / tablet.count : 0;
			const tabletPosition = tablet.count > 0 ? tablet.position / tablet.count : 0;
			const tabletPercent = totalClicks > 0 ? (tabletClicks / totalClicks) * 100 : 0;

			// Find primary device
			const primaryDevice =
				mobileClicks > desktopClicks && mobileClicks > tabletClicks ? 'MOBILE' : desktopClicks > tabletClicks ? 'DESKTOP' : 'TABLET';
			const primaryPercent = primaryDevice === 'MOBILE' ? mobilePercent : primaryDevice === 'DESKTOP' ? desktopPercent : tabletPercent;

			// Find best/worst CTR
			const ctrs: Array<{ device: string; ctr: number }> = [
				{ device: 'MOBILE', ctr: mobileCtr },
				{ device: 'DESKTOP', ctr: desktopCtr },
				{ device: 'TABLET', ctr: tabletCtr },
			];
			const bestCtrDevice = ctrs.reduce((best: { device: string; ctr: number }, curr: { device: string; ctr: number }) =>
				curr.ctr > best.ctr ? curr : best
			).device;
			const worstCtrDevice = ctrs.reduce((worst: { device: string; ctr: number }, curr: { device: string; ctr: number }) =>
				curr.ctr < worst.ctr ? curr : worst
			).device;
			const bestCtr = ctrs.find((d) => d.device === bestCtrDevice)?.ctr || 0;
			const worstCtr = ctrs.find((d) => d.device === worstCtrDevice)?.ctr || 0;
			const ctrGap = bestCtr - worstCtr;

			// Find best/worst position
			const positions: Array<{ device: string; position: number }> = [
				{ device: 'MOBILE', position: mobilePosition },
				{ device: 'DESKTOP', position: desktopPosition },
				{ device: 'TABLET', position: tabletPosition },
			];
			const bestPositionDevice = positions.reduce(
				(best: { device: string; position: number }, curr: { device: string; position: number }) =>
					curr.position < best.position ? curr : best
			).device;
			const worstPositionDevice = positions.reduce(
				(worst: { device: string; position: number }, curr: { device: string; position: number }) =>
					curr.position > worst.position ? curr : worst
			).device;
			const bestPosition = positions.find((d) => d.device === bestPositionDevice)?.position || 0;
			const worstPosition = positions.find((d) => d.device === worstPositionDevice)?.position || 0;

			const generateDeviceInsights = (): string => {
				const insights: string[] = [];
				if (mobilePercent > 60) {
					insights.push('📱 Mobile-first traffic: Majority of traffic comes from mobile devices');
				} else if (desktopPercent > 60) {
					insights.push('💻 Desktop-focused: Most traffic comes from desktop devices');
				}
				if (ctrGap > 2) {
					insights.push(`⚠ CTR gap of ${ctrGap.toFixed(2)}% between devices - optimize underperforming device`);
				}
				if (worstPosition - bestPosition > 5) {
					insights.push(
						`⚠ Position gap of ${(worstPosition - bestPosition).toFixed(1)} positions - improve rankings for ${worstPositionDevice}`
					);
				}
				return insights.length > 0 ? insights.join('\n') : 'Device performance is balanced';
			};

			const generateDeviceRecommendations = (): string => {
				const recommendations: string[] = [];
				if (mobilePercent > 50 && mobileCtr < desktopCtr) {
					recommendations.push('- Optimize mobile experience to improve mobile CTR');
				}
				if (worstCtrDevice === 'MOBILE') {
					recommendations.push('- Focus on mobile optimization: improve page speed, mobile usability');
				}
				if (worstPositionDevice === 'MOBILE') {
					recommendations.push('- Improve mobile rankings: ensure mobile-friendly content and structure');
				}
				return recommendations.length > 0 ? recommendations.join('\n') : '- Continue monitoring device performance';
			};

			const mobilePriority = mobileCtr < 2 || mobilePosition > 15 ? 'HIGH' : mobileCtr < 3 || mobilePosition > 10 ? 'MEDIUM' : 'LOW';

			return {
				content: [
					{
						type: 'text',
						text: `Device Performance Breakdown:

Site: ${siteUrl}
Date Range: ${startDate} to ${endDate}

Overall Traffic Distribution:

📱 MOBILE
   Clicks: ${mobileClicks.toLocaleString()} (${mobilePercent.toFixed(1)}%)
   Impressions: ${mobileImpressions.toLocaleString()}
   CTR: ${mobileCtr.toFixed(2)}%
   Avg Position: ${mobilePosition.toFixed(1)}

💻 DESKTOP
   Clicks: ${desktopClicks.toLocaleString()} (${desktopPercent.toFixed(1)}%)
   Impressions: ${desktopImpressions.toLocaleString()}
   CTR: ${desktopCtr.toFixed(2)}%
   Avg Position: ${desktopPosition.toFixed(1)}

📲 TABLET
   Clicks: ${tabletClicks.toLocaleString()} (${tabletPercent.toFixed(1)}%)
   Impressions: ${tabletImpressions.toLocaleString()}
   CTR: ${tabletCtr.toFixed(2)}%
   Avg Position: ${tabletPosition.toFixed(1)}

Performance Analysis:

Primary Device: ${primaryDevice}
${primaryDevice === 'MOBILE' ? '📱' : primaryDevice === 'DESKTOP' ? '💻' : '📲'} ${primaryDevice} generates ${primaryPercent.toFixed(
							1
						)}% of total traffic

CTR Comparison:
${bestCtrDevice === 'MOBILE' ? '✓ Mobile' : bestCtrDevice === 'DESKTOP' ? '✓ Desktop' : '✓ Tablet'} has the best CTR at ${bestCtr.toFixed(
							2
						)}%
${worstCtrDevice} has the lowest CTR at ${worstCtr.toFixed(2)}% (${ctrGap.toFixed(2)}% gap)

Position Comparison:
${bestPositionDevice} ranks best at position ${bestPosition.toFixed(1)}
${worstPositionDevice} ranks worst at position ${worstPosition.toFixed(1)}

Insights:
${generateDeviceInsights()}

Recommendations:
${generateDeviceRecommendations()}

Mobile Optimization Priority: ${mobilePriority}
${
	mobilePriority === 'HIGH'
		? '⚠ Mobile performance needs immediate attention'
		: mobilePriority === 'MEDIUM'
		? '→ Consider mobile improvements'
		: '✓ Mobile performance is healthy'
}`,
					},
				],
			};
		},
	},
	{
		name: 'get_country_breakdown',
		description:
			'Analyzes search performance across different countries to identify geographic expansion opportunities, localization needs, or regional performance issues.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'Site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				startDate: {
					type: 'string',
					description: 'Start date in YYYY-MM-DD format',
				},
				endDate: {
					type: 'string',
					description: 'End date in YYYY-MM-DD format',
				},
				topN: {
					type: 'string',
					description: 'Number of top countries to return. Default: 10',
				},
				additionalDimension: {
					type: 'string',
					description: 'Additional dimension to break down by (e.g., "query"). Default: none',
				},
			},
			required: ['siteUrl', 'startDate', 'endDate'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const startDate = args.startDate as string;
			const endDate = args.endDate as string;
			const topN = parseInt(String(args.topN || '10'), 10);
			const additionalDimension = args.additionalDimension as string | undefined;

			// Validate dates
			const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
			if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
				throw new Error('Dates must be in YYYY-MM-DD format');
			}

			// Build dimensions
			const dimensions = additionalDimension ? ['country', additionalDimension] : ['country'];

			// Get search analytics data
			const requestBody = {
				startDate,
				endDate,
				dimensions,
				rowLimit: 25000,
				startRow: 0,
				dataState: 'final',
			};

			const encodedSiteUrl = encodeURIComponent(siteUrl);
			const response = await gscApiRequest(
				`https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`,
				{
					method: 'POST',
					body: JSON.stringify(requestBody),
				},
				env
			);

			if (!response.ok) {
				throw new Error(`Failed to fetch search analytics: ${response.status}`);
			}

			const data = (await response.json()) as {
				rows?: Array<{
					keys: string[];
					clicks: number;
					impressions: number;
					ctr: number;
					position: number;
				}>;
			};

			const rows = data.rows || [];

			// Aggregate by country
			const countryData: Record<string, { clicks: number; impressions: number; ctr: number; position: number; count: number }> = {};

			rows.forEach((row: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }) => {
				const country = row.keys[0] || 'UNKNOWN';
				if (!countryData[country]) {
					countryData[country] = { clicks: 0, impressions: 0, ctr: 0, position: 0, count: 0 };
				}
				countryData[country].clicks += row.clicks;
				countryData[country].impressions += row.impressions;
				countryData[country].ctr += row.ctr;
				countryData[country].position += row.position;
				countryData[country].count += 1;
			});

			// Calculate totals
			const totalClicks = Object.values(countryData).reduce((sum, c) => sum + c.clicks, 0);

			// Convert to array and sort by clicks
			const countries = Object.entries(countryData)
				.map(([country, data]) => ({
					country,
					clicks: data.clicks,
					impressions: data.impressions,
					ctr: data.count > 0 ? data.ctr / data.count : 0,
					position: data.count > 0 ? data.position / data.count : 0,
					percentage: totalClicks > 0 ? (data.clicks / totalClicks) * 100 : 0,
				}))
				.sort((a, b) => b.clicks - a.clicks)
				.slice(0, topN);

			// Country name mapping (ISO 3166-1 alpha-3 to common names)
			const countryNames: Record<string, string> = {
				USA: 'United States',
				GBR: 'United Kingdom',
				CAN: 'Canada',
				AUS: 'Australia',
				DEU: 'Germany',
				FRA: 'France',
				ITA: 'Italy',
				ESP: 'Spain',
				NLD: 'Netherlands',
				BEL: 'Belgium',
				SWE: 'Sweden',
				NOR: 'Norway',
				DNK: 'Denmark',
				FIN: 'Finland',
				POL: 'Poland',
				JPN: 'Japan',
				CHN: 'China',
				IND: 'India',
				BRA: 'Brazil',
				MEX: 'Mexico',
				ARG: 'Argentina',
				ZAF: 'South Africa',
			};

			// Country flag emojis (simplified - using common ones)
			const countryFlags: Record<string, string> = {
				USA: '🇺🇸',
				GBR: '🇬🇧',
				CAN: '🇨🇦',
				AUS: '🇦🇺',
				DEU: '🇩🇪',
				FRA: '🇫🇷',
				ITA: '🇮🇹',
				ESP: '🇪🇸',
				NLD: '🇳🇱',
				BEL: '🇧🇪',
				SWE: '🇸🇪',
				NOR: '🇳🇴',
				DNK: '🇩🇰',
				FIN: '🇫🇮',
				POL: '🇵🇱',
				JPN: '🇯🇵',
				CHN: '🇨🇳',
				IND: '🇮🇳',
				BRA: '🇧🇷',
				MEX: '🇲🇽',
				ARG: '🇦🇷',
				ZAF: '🇿🇦',
			};

			const countriesText = countries
				.map(
					(c: { country: string; clicks: number; impressions: number; ctr: number; position: number; percentage: number }, i: number) => {
						const countryName = countryNames[c.country] || c.country;
						const countryFlag = countryFlags[c.country] || '🌍';
						return `${i + 1}. ${countryFlag} ${countryName} (${c.country})
   Clicks: ${c.clicks.toLocaleString()} (${c.percentage.toFixed(1)}%)
   Impressions: ${c.impressions.toLocaleString()}
   CTR: ${c.ctr.toFixed(2)}%
   Avg Position: ${c.position.toFixed(1)}`;
					}
				)
				.join('\n\n');

			// Find primary country
			const primaryCountry = countries[0]?.country || 'UNKNOWN';
			const primaryCountryName = countryNames[primaryCountry] || primaryCountry;
			const primaryCountryFlag = countryFlags[primaryCountry] || '🌍';
			const primaryPercent = countries[0]?.percentage || 0;

			// Calculate top N percentage
			const topNPercent = countries.reduce((sum, c) => sum + c.percentage, 0);
			const remainingPercent = 100 - topNPercent;

			// Find best/worst CTR
			type CountryData = { country: string; clicks: number; impressions: number; ctr: number; position: number; percentage: number };
			const bestCtrCountry = countries.reduce((best: CountryData, curr: CountryData) => (curr.ctr > best.ctr ? curr : best));
			const worstCtrCountry = countries.reduce((worst: CountryData, curr: CountryData) => (curr.ctr < worst.ctr ? curr : worst));
			const bestCtr = bestCtrCountry.ctr;
			const worstCtr = worstCtrCountry.ctr;
			const ctrVariance = bestCtr - worstCtr;

			// Find best/worst position
			const bestPositionCountry = countries.reduce((best: CountryData, curr: CountryData) => (curr.position < best.position ? curr : best));
			const worstPositionCountry = countries.reduce((worst: CountryData, curr: CountryData) =>
				curr.position > worst.position ? curr : worst
			);
			const bestPosition = bestPositionCountry.position;
			const worstPosition = worstPositionCountry.position;

			// Categorize markets
			const establishedMarkets: string[] = [];
			const growingMarkets: string[] = [];
			const opportunityMarkets: string[] = [];

			countries.forEach((c: { country: string; percentage: number; position: number }) => {
				if (c.percentage > 10 && c.position < 10) {
					establishedMarkets.push(countryNames[c.country] || c.country);
				} else if (c.percentage > 5 && c.position < 15) {
					growingMarkets.push(countryNames[c.country] || c.country);
				} else if (c.position < 20) {
					opportunityMarkets.push(countryNames[c.country] || c.country);
				}
			});

			const generateCountryInsights = (): string => {
				const insights: string[] = [];
				if (primaryPercent > 50) {
					insights.push(`🌍 ${primaryCountryName} dominates with ${primaryPercent.toFixed(1)}% of traffic`);
				}
				if (ctrVariance > 3) {
					insights.push(`⚠ CTR variance of ${ctrVariance.toFixed(2)}% across countries - consider localization`);
				}
				if (opportunityMarkets.length > 0) {
					insights.push(`💡 ${opportunityMarkets.length} opportunity markets identified for expansion`);
				}
				return insights.length > 0 ? insights.join('\n') : 'Geographic performance is balanced';
			};

			const generateCountryRecommendations = (): string => {
				const recommendations: string[] = [];
				if (primaryPercent > 70) {
					recommendations.push('- Consider expanding to other markets - high concentration in one country');
				}
				if (opportunityMarkets.length > 0) {
					recommendations.push(`- Target opportunity markets: ${opportunityMarkets.slice(0, 3).join(', ')}`);
				}
				if (worstCtrCountry.ctr < 2) {
					recommendations.push(
						`- Improve CTR in ${countryNames[worstCtrCountry.country] || worstCtrCountry.country} - optimize for local preferences`
					);
				}
				return recommendations.length > 0 ? recommendations.join('\n') : '- Continue current geographic strategy';
			};

			const generateGeoStrategy = (): string => {
				if (establishedMarkets.length > 0) {
					return `Maintain strong presence in established markets (${establishedMarkets.join(', ')}).
Consider localization for growing markets and expansion into opportunity markets.`;
				}
				return 'Focus on building presence in top markets before expanding.';
			};

			return {
				content: [
					{
						type: 'text',
						text: `Geographic Performance Breakdown:

Site: ${siteUrl}
Date Range: ${startDate} to ${endDate}
Showing: Top ${topN} countries by traffic

Traffic Distribution:

${countriesText}

Geographic Analysis:

Primary Market: ${primaryCountry}
${primaryCountryFlag} ${primaryCountryName} dominates with ${primaryPercent.toFixed(1)}% of traffic

Top ${topN} Countries: ${topNPercent.toFixed(1)}% of total traffic
Remaining Countries: ${remainingPercent.toFixed(1)}% of total traffic

Performance Insights:

Best CTR: ${countryNames[bestCtrCountry.country] || bestCtrCountry.country} at ${bestCtr.toFixed(2)}%
Lowest CTR: ${countryNames[worstCtrCountry.country] || worstCtrCountry.country} at ${worstCtr.toFixed(2)}%
CTR Variance: ${ctrVariance.toFixed(2)}%

Best Rankings: ${countryNames[bestPositionCountry.country] || bestPositionCountry.country} at position ${bestPosition.toFixed(1)}
Opportunity: ${countryNames[worstPositionCountry.country] || worstPositionCountry.country} at position ${worstPosition.toFixed(
							1
						)} - potential for growth

Market Maturity:
✓ Established: ${establishedMarkets.length > 0 ? establishedMarkets.join(', ') : 'None'}
→ Growing: ${growingMarkets.length > 0 ? growingMarkets.join(', ') : 'None'}
💡 Opportunity: ${opportunityMarkets.length > 0 ? opportunityMarkets.join(', ') : 'None'}

Insights:
${generateCountryInsights()}

Recommendations:
${generateCountryRecommendations()}

Geographic Strategy:
${generateGeoStrategy()}`,
					},
				],
			};
		},
	},
	{
		name: 'detect_indexing_issues',
		description:
			'Checks multiple important URLs for indexing problems and provides a prioritized list of issues that need attention. Useful for technical SEO audits.',
		inputSchema: {
			type: 'object',
			properties: {
				siteUrl: {
					type: 'string',
					description: 'Site URL property (e.g., "https://example.com/" or "sc-domain:example.com")',
				},
				urls: {
					type: 'string',
					description: 'JSON array of URLs to check (max 20). Example: ["https://example.com/page1", "https://example.com/page2"]',
				},
			},
			required: ['siteUrl', 'urls'],
		},
		handler: async (args: Record<string, unknown>, env: Env) => {
			const siteUrl = args.siteUrl as string;
			const urlsInput = args.urls;

			if (!siteUrl) {
				throw new Error('siteUrl parameter is required');
			}

			// Parse URLs
			let urls: string[] = [];
			if (Array.isArray(urlsInput)) {
				urls = urlsInput.map((u) => String(u).trim()).filter(Boolean);
			} else if (typeof urlsInput === 'string') {
				try {
					const parsed = JSON.parse(urlsInput);
					if (Array.isArray(parsed)) {
						urls = parsed.map((u) => String(u).trim()).filter(Boolean);
					} else {
						throw new Error('urls must be an array');
					}
				} catch {
					throw new Error('urls must be a JSON array string or array');
				}
			}

			if (urls.length === 0) {
				throw new Error('At least one URL is required');
			}

			if (urls.length > 20) {
				throw new Error('Maximum 20 URLs per check (rate limit)');
			}

			// Use batch_inspect_urls logic to inspect all URLs
			const inspectionResults: Array<{
				url: string;
				indexed: boolean;
				verdict: string;
				indexingState: string;
				robotsTxtState: string;
				pageFetchState: string;
				mobileIssues: number;
				richResultsIssues: boolean;
				canonicalIssues: boolean;
			}> = [];

			for (let i = 0; i < urls.length; i++) {
				const url = urls[i];
				try {
					const requestBody = {
						inspectionUrl: url,
						siteUrl,
						languageCode: 'en-US',
					};

					const response = await gscApiRequest(
						'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
						{
							method: 'POST',
							body: JSON.stringify(requestBody),
						},
						env
					);

					if (response.ok) {
						const data = (await response.json()) as {
							inspectionResult?: {
								indexStatusResult?: {
									verdict?: string;
									indexingState?: string;
									robotsTxtState?: string;
									pageFetchState?: string;
									googleCanonical?: string;
									userCanonical?: string;
									mobileUsabilityResult?: {
										verdict?: string;
										issues?: Array<unknown>;
									};
									richResultsResult?: {
										verdict?: string;
									};
								};
							};
						};

						const result = data.inspectionResult?.indexStatusResult;
						const verdict = result?.verdict || 'UNKNOWN';
						const indexingState = result?.indexingState || 'UNKNOWN';
						const indexed = indexingState === 'INDEXING_ALLOWED' && verdict === 'PASS';
						const robotsTxtState = result?.robotsTxtState || 'UNKNOWN';
						const pageFetchState = result?.pageFetchState || 'UNKNOWN';
						const mobileIssues = result?.mobileUsabilityResult?.issues?.length || 0;
						const richResultsIssues = result?.richResultsResult?.verdict === 'FAIL';
						const googleCanonical = result?.googleCanonical || '';
						const userCanonical = result?.userCanonical || '';
						const canonicalIssues = googleCanonical !== userCanonical && googleCanonical !== '' && userCanonical !== '';

						inspectionResults.push({
							url,
							indexed,
							verdict,
							indexingState,
							robotsTxtState,
							pageFetchState,
							mobileIssues,
							richResultsIssues,
							canonicalIssues,
						});
					} else {
						inspectionResults.push({
							url,
							indexed: false,
							verdict: 'ERROR',
							indexingState: 'UNKNOWN',
							robotsTxtState: 'UNKNOWN',
							pageFetchState: 'UNKNOWN',
							mobileIssues: 0,
							richResultsIssues: false,
							canonicalIssues: false,
						});
					}
				} catch {
					inspectionResults.push({
						url,
						indexed: false,
						verdict: 'ERROR',
						indexingState: 'UNKNOWN',
						robotsTxtState: 'UNKNOWN',
						pageFetchState: 'UNKNOWN',
						mobileIssues: 0,
						richResultsIssues: false,
						canonicalIssues: false,
					});
				}

				// Add delay between requests
				if (i < urls.length - 1) {
					await new Promise<void>((resolve: () => void) => setTimeout(resolve, 100));
				}
			}

			// Categorize issues by severity
			const healthyUrls: string[] = [];
			const highSeverityIssues: Array<{ type: string; affectedUrls: string[]; description: string; recommendation: string }> = [];
			const mediumSeverityIssues: Array<{ type: string; affectedUrls: string[]; description: string; recommendation: string }> = [];
			const lowSeverityIssues: Array<{ type: string; affectedUrls: string[]; description: string; recommendation: string }> = [];

			inspectionResults.forEach(
				(result: {
					indexed: boolean;
					verdict: string;
					mobileIssues: number;
					richResultsIssues: boolean;
					canonicalIssues: boolean;
					url: string;
					indexingState: string;
					robotsTxtState: string;
					pageFetchState: string;
				}) => {
					if (
						result.indexed &&
						result.verdict === 'PASS' &&
						result.mobileIssues === 0 &&
						!result.richResultsIssues &&
						!result.canonicalIssues
					) {
						healthyUrls.push(result.url);
					} else {
						if (!result.indexed || result.indexingState !== 'INDEXING_ALLOWED') {
							// High severity
							const existing = highSeverityIssues.find((i) => i.type === 'Not Indexed');
							if (existing) {
								existing.affectedUrls.push(result.url);
							} else {
								highSeverityIssues.push({
									type: 'Not Indexed',
									affectedUrls: [result.url],
									description: 'URL is not being indexed by Google',
									recommendation: 'Check robots.txt, ensure URL is in sitemap, verify no noindex tags',
								});
							}
						}

						if (result.robotsTxtState !== 'ALLOWED') {
							const existing = highSeverityIssues.find((i) => i.type === 'Robots.txt Blocked');
							if (existing) {
								existing.affectedUrls.push(result.url);
							} else {
								highSeverityIssues.push({
									type: 'Robots.txt Blocked',
									affectedUrls: [result.url],
									description: 'URL is blocked by robots.txt',
									recommendation: 'Review and update robots.txt to allow indexing',
								});
							}
						}

						if (result.pageFetchState !== 'SUCCESSFUL') {
							const existing = highSeverityIssues.find((i) => i.type === 'Page Fetch Failed');
							if (existing) {
								existing.affectedUrls.push(result.url);
							} else {
								highSeverityIssues.push({
									type: 'Page Fetch Failed',
									affectedUrls: [result.url],
									description: 'Google cannot fetch the page',
									recommendation: 'Check server configuration, SSL certificates, and page accessibility',
								});
							}
						}

						if (result.mobileIssues > 0) {
							const existing = mediumSeverityIssues.find((i) => i.type === 'Mobile Usability Issues');
							if (existing) {
								existing.affectedUrls.push(result.url);
							} else {
								mediumSeverityIssues.push({
									type: 'Mobile Usability Issues',
									affectedUrls: [result.url],
									description: `Mobile usability problems detected (${result.mobileIssues} issues)`,
									recommendation: 'Fix mobile usability issues to improve mobile search performance',
								});
							}
						}

						if (result.canonicalIssues) {
							const existing = lowSeverityIssues.find((i) => i.type === 'Canonical Mismatch');
							if (existing) {
								existing.affectedUrls.push(result.url);
							} else {
								lowSeverityIssues.push({
									type: 'Canonical Mismatch',
									affectedUrls: [result.url],
									description: 'Google canonical differs from user-declared canonical',
									recommendation: 'Align canonical tags to ensure proper indexing',
								});
							}
						}

						if (result.richResultsIssues) {
							const existing = lowSeverityIssues.find((i) => i.type === 'Rich Results Issues');
							if (existing) {
								existing.affectedUrls.push(result.url);
							} else {
								lowSeverityIssues.push({
									type: 'Rich Results Issues',
									affectedUrls: [result.url],
									description: 'Structured data issues detected',
									recommendation: 'Fix structured data markup to enable rich results',
								});
							}
						}
					}
				}
			);

			const totalChecked = inspectionResults.length;
			const healthyCount = healthyUrls.length;
			const healthyPercent = totalChecked > 0 ? (healthyCount / totalChecked) * 100 : 0;
			const issuesCount = totalChecked - healthyCount;
			const issuesPercent = totalChecked > 0 ? (issuesCount / totalChecked) * 100 : 0;

			const highSeverityCount = highSeverityIssues.reduce((sum, i) => sum + i.affectedUrls.length, 0);
			const mediumSeverityCount = mediumSeverityIssues.reduce((sum, i) => sum + i.affectedUrls.length, 0);
			const lowSeverityCount = lowSeverityIssues.reduce((sum, i) => sum + i.affectedUrls.length, 0);

			type IssueType = { type: string; affectedUrls: string[]; description: string; recommendation: string };
			const formatIssues = (issues: IssueType[]) => {
				return issues
					.map(
						(issue) => `
   ${issue.type}
   Affected URLs (${issue.affectedUrls.length}):
   ${issue.affectedUrls.map((url) => `   - ${url}`).join('\n')}

   Description: ${issue.description}
   → Action Required: ${issue.recommendation}`
					)
					.join('\n');
			};

			const priorityActions = [
				highSeverityIssues.length > 0
					? `Fix ${highSeverityCount} high-priority issues (${highSeverityIssues.map((i) => i.type).join(', ')})`
					: 'No high-priority issues',
				mediumSeverityIssues.length > 0
					? `Address ${mediumSeverityCount} medium-priority issues (${mediumSeverityIssues.map((i) => i.type).join(', ')})`
					: 'No medium-priority issues',
				lowSeverityIssues.length > 0
					? `Review ${lowSeverityCount} low-priority issues (${lowSeverityIssues.map((i) => i.type).join(', ')})`
					: 'No low-priority issues',
			];

			const generateImpactEstimate = (): string => {
				if (highSeverityCount > 0) {
					return `Fixing high-priority issues could improve indexing for ${highSeverityCount} URLs`;
				}
				if (mediumSeverityCount > 0) {
					return `Addressing medium-priority issues could improve user experience and search performance`;
				}
				return 'Minor optimizations could further improve search performance';
			};

			const generateNextSteps = (): string => {
				const steps: string[] = [];
				if (highSeverityIssues.length > 0) {
					steps.push('1. Fix robots.txt and indexing issues immediately');
				}
				if (mediumSeverityIssues.length > 0) {
					steps.push('2. Address mobile usability issues');
				}
				if (lowSeverityIssues.length > 0) {
					steps.push('3. Review and fix canonical and structured data issues');
				}
				return steps.length > 0 ? steps.join('\n') : 'Continue monitoring URL health';
			};

			const healthScore = Math.round(100 - (highSeverityCount * 30 + mediumSeverityCount * 15 + lowSeverityCount * 5) / totalChecked);

			return {
				content: [
					{
						type: 'text',
						text: `Indexing Issues Report:

Site: ${siteUrl}
URLs Checked: ${totalChecked}

Summary:
✓ Healthy: ${healthyCount} URLs (${healthyPercent.toFixed(1)}%)
⚠ Issues Found: ${issuesCount} URLs (${issuesPercent.toFixed(1)}%)

Issues by Severity:

${
	highSeverityCount > 0
		? `❌ HIGH PRIORITY (${highSeverityCount} issues)
${formatIssues(highSeverityIssues)}
`
		: ''
}
${
	mediumSeverityCount > 0
		? `⚠ MEDIUM PRIORITY (${mediumSeverityCount} issues)
${formatIssues(mediumSeverityIssues)}
`
		: ''
}
${
	lowSeverityCount > 0
		? `ℹ️ LOW PRIORITY (${lowSeverityCount} issues)
${formatIssues(lowSeverityIssues)}
`
		: ''
}
${
	healthyUrls.length > 0
		? `
✓ Healthy URLs (${healthyUrls.length}):
${healthyUrls.map((url) => `   ✓ ${url}`).join('\n')}
`
		: ''
}

Priority Action Plan:

1. ${priorityActions[0]}
2. ${priorityActions[1]}
3. ${priorityActions[2]}

Expected Impact:
${generateImpactEstimate()}

Next Steps:
${generateNextSteps()}

Technical SEO Health Score: ${healthScore}/100
${
	healthScore >= 90
		? '✓ Excellent - Site is healthy'
		: healthScore >= 70
		? '→ Good - Minor improvements needed'
		: healthScore >= 50
		? '⚠ Fair - Several issues to address'
		: '❌ Poor - Immediate action required'
}`,
					},
				],
			};
		},
	},
];

/**
 * ============================================================================
 * FRAMEWORK CODE - You typically don't need to modify below this line
 * ============================================================================
 */

// Session interface for SSE connections
interface Session {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	encoder: TextEncoder;
}

// Store active sessions
const sessions = new Map<string, Session>();

/**
 * Validate API key from request header
 */
function validateApiKey(request: Request, env: Env): boolean {
	const apiKey = request.headers.get('X-API-Key');
	const expectedApiKey = env.API_KEY;

	// If no API key is configured, allow all requests (backward compatibility)
	if (!expectedApiKey) {
		return true;
	}

	// If API key is configured, require it
	if (!apiKey) {
		return false;
	}

	return apiKey === expectedApiKey;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// CORS headers - modify if you need to restrict origins
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*', // Change to specific domain if needed
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Accept, X-API-Key',
		};

		console.log(`${request.method} ${url.pathname}`);

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// Validate API key (skip for health check endpoint)
		if (url.pathname !== '/' && url.pathname !== '') {
			if (!validateApiKey(request, env)) {
				return new Response(
					JSON.stringify({
						error: 'Unauthorized',
						message: 'Invalid or missing X-API-Key header',
					}),
					{
						status: 401,
						headers: {
							'Content-Type': 'application/json',
							...corsHeaders,
						},
					}
				);
			}
		}

		// Health check endpoint
		if (url.pathname === '/' || url.pathname === '') {
			return new Response(
				JSON.stringify({
					name: CONFIG.serverDescription,
					version: CONFIG.serverVersion,
					status: 'running',
					endpoints: {
						sse: '/sse',
					},
				}),
				{
					headers: {
						'Content-Type': 'application/json',
						...corsHeaders,
					},
				}
			);
		}

		// SSE endpoint - GET only
		if (url.pathname === '/sse' && request.method === 'GET') {
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			// Generate session ID
			const sessionId = crypto.randomUUID().replace(/-/g, '');

			// Store session
			sessions.set(sessionId, { writer, encoder });
			console.log('Created SSE session:', sessionId);

			// Send endpoint immediately
			(async () => {
				try {
					await writer.write(encoder.encode(`event: endpoint\ndata: /sse/message?sessionId=${sessionId}\n\n`));

					// Keep-alive ping
					const keepAlive = setInterval(async () => {
						try {
							await writer.write(encoder.encode(': ping\n\n'));
						} catch {
							clearInterval(keepAlive);
							sessions.delete(sessionId);
						}
					}, CONFIG.keepAliveInterval);
				} catch (error) {
					console.error('SSE error:', error);
					sessions.delete(sessionId);
				}
			})();

			return new Response(readable, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
					...corsHeaders,
				},
			});
		}

		// Handle POST to /sse (some clients do this for direct HTTP)
		if (url.pathname === '/sse' && request.method === 'POST') {
			console.log('Received POST to /sse - redirecting to message handler');
			// Treat this as a direct message without session
			return handleMessage(request, corsHeaders, null, env);
		}

		// Messages endpoint with session
		if (url.pathname === '/sse/message' && request.method === 'POST') {
			const sessionId = url.searchParams.get('sessionId');
			console.log('Received POST to /sse/message with sessionId:', sessionId);

			const session = sessions.get(sessionId || '') ?? null;
			return handleMessage(request, corsHeaders, session, env);
		}

		return new Response('Not Found', {
			status: 404,
			headers: corsHeaders,
		});
	},
};

// Centralized message handler
async function handleMessage(request: Request, corsHeaders: Record<string, string>, session: Session | null, env: Env) {
	try {
		const body = await request.text();
		console.log('Received body:', body);

		let message;
		try {
			message = JSON.parse(body);
		} catch (parseError) {
			console.error('JSON parse error:', parseError);
			const errorResponse = {
				jsonrpc: '2.0',
				error: {
					code: -32700,
					message: 'Parse error',
				},
			};
			return new Response(JSON.stringify(errorResponse), {
				status: 400,
				headers: {
					'Content-Type': 'application/json',
					...corsHeaders,
				},
			});
		}

		console.log('Parsed message:', JSON.stringify(message));

		let response: Record<string, unknown> | null = null;

		// Handle initialize
		if (message.method === 'initialize') {
			response = {
				jsonrpc: '2.0',
				id: message.id,
				result: {
					protocolVersion: CONFIG.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: {
						name: CONFIG.serverName,
						version: CONFIG.serverVersion,
					},
				},
			};
		}
		// Handle tools/list
		else if (message.method === 'tools/list') {
			response = {
				jsonrpc: '2.0',
				id: message.id,
				result: {
					tools: TOOLS.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
					})),
				},
			};
		}
		// Handle tools/call
		else if (message.method === 'tools/call') {
			const { name, arguments: args } = message.params;

			// Find the tool by name
			const tool = TOOLS.find((t) => t.name === name);

			if (tool) {
				try {
					const result = await tool.handler(args, env);
					response = {
						jsonrpc: '2.0',
						id: message.id,
						result,
					};
				} catch (toolError) {
					response = {
						jsonrpc: '2.0',
						id: message.id,
						error: {
							code: -32603,
							message: toolError instanceof Error ? toolError.message : 'Tool execution failed',
						},
					};
				}
			} else {
				response = {
					jsonrpc: '2.0',
					id: message.id,
					error: {
						code: -32601,
						message: `Unknown tool: ${name}`,
					},
				};
			}
		}
		// Handle notifications/initialized
		else if (message.method === 'notifications/initialized') {
			console.log('Received initialized notification');
			return new Response(null, {
				status: 204,
				headers: corsHeaders,
			});
		} else {
			response = {
				jsonrpc: '2.0',
				id: message.id || null,
				error: {
					code: -32601,
					message: `Method not found: ${message.method}`,
				},
			};
		}

		console.log('Sending response:', JSON.stringify(response));

		// If we have a session, send via SSE
		if (session && response) {
			try {
				await session.writer.write(session.encoder.encode(`data: ${JSON.stringify(response)}\n\n`));
			} catch (sseError) {
				console.error('SSE write error:', sseError);
			}
		}

		// Always return response directly for HTTP
		if (response) {
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					...corsHeaders,
				},
			});
		}

		return new Response(null, {
			status: 204,
			headers: corsHeaders,
		});
	} catch (error: unknown) {
		console.error('Message handling error:', error);
		const errorResponse = {
			jsonrpc: '2.0',
			error: {
				code: -32603,
				message: error instanceof Error ? error.message : 'Internal error',
			},
		};
		return new Response(JSON.stringify(errorResponse), {
			status: 500,
			headers: {
				'Content-Type': 'application/json',
				...corsHeaders,
			},
		});
	}
}
