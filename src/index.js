/**
Basic API for a simple key-value store that mirrors the content of the live timing API.

The API supports the following methods:
- GET /static/{key}: Retrieve the value of the key.
- PUT /static/{key}: Store a new value for the key. Requires authentication.
- DELETE /static/{key}: Delete the value of the key. Requires authentication.

Authentication is done using a pre-shared key that is passed in the X-FASTF1-LIVETIMING-MIRROR-AUTH header.
 */

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// only allow requests to the /static/ path
		if (!url.pathname.startsWith('/static/')) {
			return new Response('Bad Request', { status: 400 });
		}

		// remove the "/static/" prefix to get the cache key
		const key = url.pathname.slice(8);

		const CACHE_MAX_AGE = env.MAX_CACHE_AGE || 3600;
		const NOT_FOUND_DELAY = env.NOT_FOUND_DELAY || 100;

		// verify the request method and authentication
		const supportedMethods = ['GET', 'PUT', 'DELETE'];
		const authenticatedMethods = ['PUT', 'DELETE'];

		const PRESHARED_AUTH_HEADER_KEY = "X-FASTF1-LIVETIMING-MIRROR-AUTH";
		const AUTH_KEY_SECRET = env.AUTH_KEY_SECRET;

		// verify authentication in a timing safe manner
		var isAuthenticated = false;
		const authToken = request.headers.get(PRESHARED_AUTH_HEADER_KEY) || "";

		// ensure token length and encoded byte length before comparing to avoid timing attacks
		if (authToken.length === AUTH_KEY_SECRET.length) {
			const encoder = new TextEncoder();
			const a = encoder.encode(authToken);
			const b = encoder.encode(AUTH_KEY_SECRET);

			if (a.byteLength === b.byteLength) {
				isAuthenticated = (crypto.subtle.timingSafeEqual(a, b));
			}
		  }

		// check that the request method is supported
		if (!supportedMethods.includes(request.method)) {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					Allow: supportedMethods.join(', '),
				},
			});
		}

		// check that the request is authenticated if the method modifes the data
		if (authenticatedMethods.includes(request.method) && !isAuthenticated) {
			return new Response('Unauthorized', {
				status: 401,
			});
		}

		// handle the request
		switch (request.method) {
			case 'PUT':
				// ensure correct content type explicitly
				let contentTypeValue = '';
				if (key.endsWith('.jsonStream')) {
					contentTypeValue = 'application/octet-stream';
				} else if (key.endsWith('.json')) {
					contentTypeValue = 'application/json';
				}
				await env.LIVETIMING_BUCKET.put(
					key, request.body,
					{httpMetadata:
						{contentType: contentTypeValue}
					}
				);
				return new Response(`Put ${key} successfully!`);
			case 'GET':
				if (key === '') {
					return new Response('Status OK');
				}

				// Implement crude rate limiting using a KV store
				const RATE_LIMIT_REQUESTS_PER_HOUR = parseInt(env.RATE_LIMIT_REQUESTS_PER_HOUR || 200);
				const RATE_LIMIT_DELAY = parseInt(env.RATE_LIMIT_DELAY || 0);
				const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
				const hourBucket = Math.floor(Date.now() / 3600000);
				const rlKey = `${ip}:${hourBucket}`;

				const rlCount = parseInt(await env.RATE_LIMIT.get(rlKey) || '0');
				if (rlCount >= RATE_LIMIT_REQUESTS_PER_HOUR) {
					// optional based on env var: delay response for rate-limited clients in an attempt to slow them down
					// may help if clients ignore status code 429
					if (RATE_LIMIT_DELAY > 0) {
						await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
					}
					return new Response('Too Many Requests', {
						status: 429,
						headers: { 'Retry-After': '3600' },
					});
				}
				await env.RATE_LIMIT.put(rlKey, String(rlCount + 1), { expirationTtl: 7200 });

				const object = await env.LIVETIMING_BUCKET.get(key);

				if (object === null) {
					await new Promise(r => setTimeout(r, NOT_FOUND_DELAY));
					return new Response('Object Not Found', { status: 404 });
				}

				const headers = new Headers();
				object.writeHttpMetadata(headers);
				headers.set('etag', object.httpEtag);
				headers.set('Cache-Control', 'public, max-age='.concat(CACHE_MAX_AGE));

				return new Response(object.body, { headers, });

			case 'DELETE':
				await env.LIVETIMING_BUCKET.delete(key);
				return new Response('Deleted!');

			default:
				return new Response('Method Not Allowed', {
					status: 405,
					headers: {
						Allow: supportedMethods.join(', '),
					},
				});
		}
	},
};
