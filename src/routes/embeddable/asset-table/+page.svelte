<!-- Create a standalone embeddable asset table -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { writable } from 'svelte/store';
	import { ethers } from 'ethers';
	import { browser } from '$app/environment';

	// Search query
	let searchQuery = '';
	let lastHeight = 0;
	let resizeTimeout: NodeJS.Timeout;

	// Store for asset data
	const assetStore = writable<[string, string][]>([]);
	let isDarkMode = false;

	// Format encoded ID to show first 6 and last 4 chars
	function formatEncodedId(encoded: string) {
		if (encoded.length <= 10) return encoded;
		return `${encoded.slice(0, 6)}...${encoded.slice(-4)}`;
	}

	// Filtered assets
	$: filteredAssets = $assetStore.filter(([plaintext]) => 
		!searchQuery || plaintext.toLowerCase().includes(searchQuery.toLowerCase())
	);

	// Send height to parent window with debouncing
	function sendHeight() {
		if (!browser) return;
		clearTimeout(resizeTimeout);
		resizeTimeout = setTimeout(() => {
			const tableContainer = document.querySelector('.table-container');
			if (!tableContainer) {
				console.log('Table container not found');
				return;
			}
			
			const height = tableContainer.scrollHeight;
			// Only send if height has actually changed
			if (height !== lastHeight) {
				console.log('Sending height:', height + 32);
				window.parent.postMessage({ type: 'resize', height: height + 32 }, '*');
				lastHeight = height;
			}
		}, 100);
	}

	// Update height when filtered results change
	$: if (browser) {
		filteredAssets;
		sendHeight();
	}

	// Copy to clipboard function
	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch (err) {
			console.error('Failed to copy text: ', err);
		}
	}

	// Listen for theme changes from parent
	onMount(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type === 'theme') {
				console.log('Received theme update:', event.data.isDark);
				document.documentElement.style.setProperty('--table-bg', event.data.isDark ? '#1e1e1e' : '#ffffff');
				document.documentElement.style.setProperty('--table-border', event.data.isDark ? '#3f3f46' : '#6b7280');
				document.documentElement.style.setProperty('--table-header-bg', event.data.isDark ? '#27272a' : '#f3f4f6');
				document.documentElement.style.setProperty('--table-row-bg', event.data.isDark ? '#27272a' : '#ffffff');
				document.documentElement.style.setProperty('--table-alt-row-bg', event.data.isDark ? '#303034' : '#f9fafb');
				document.documentElement.style.setProperty('--table-text', event.data.isDark ? '#ffffff' : '#000000');
			}
		};
		window.addEventListener('message', handleMessage);
		
		// Request initial theme from parent
		window.parent.postMessage({ type: 'requestTheme' }, '*');

		// Set up resize observer for content changes only
		const resizeObserver = new ResizeObserver((entries) => {
			// Only trigger for actual content size changes
			const entry = entries[0];
			if (entry && entry.contentRect) {
				sendHeight();
			}
		});
		
		const tableBody = document.querySelector('tbody');
		if (tableBody) {
			resizeObserver.observe(tableBody);
		}

		// Fetch assets
		fetch('/api/assets')
			.then(response => response.json())
			.then(({ data: assetIds }) => {
				const assetPairs = assetIds.map((id: string) => [
					id,
					ethers.keccak256(ethers.toUtf8Bytes(id))
				]);
				assetStore.set(assetPairs);
				setTimeout(sendHeight, 100); // Longer delay for initial load
			})
			.catch(e => console.error('Error fetching asset IDs:', e));

		return () => {
			window.removeEventListener('message', handleMessage);
			resizeObserver.disconnect();
			clearTimeout(resizeTimeout);
		};
	});
</script>

<div class="table-container p-4 h-full">
	<!-- Search Bar -->
	<div class="card p-4 mb-4">
		<input
			type="text"
			class="input w-full"
			placeholder="Search assets..."
			bind:value={searchQuery}
		/>
	</div>

	<!-- Results Table -->
	<div class="overflow-x-auto">
		<table class="table table-compact w-full">
			<thead>
				<tr>
					<th class="w-[33%] min-w-[200px]">Asset ID</th>
					<th class="w-[67%] min-w-[200px]">Encoded ID</th>
				</tr>
			</thead>
			<tbody>
				{#if filteredAssets.length === 0}
					<tr>
						<td colspan="2" class="text-center text-gray-500 py-4">
							No assets{searchQuery ? ' matching search' : ''}.
						</td>
					</tr>
				{:else}
					{#each filteredAssets as [plaintext, encoded]}
						<tr>
							<td class="w-[33%] min-w-[200px] truncate">{plaintext}</td>
							<td class="w-[67%] min-w-[200px] font-mono text-sm encoded-cell" title={encoded}>
								<div class="flex items-center">
									<div class="min-w-0 flex-1 flex flex-row justify-start">
										<div class="flex items-center gap-1 hidden md:block">
											<span class="full-id truncate text-sm">{encoded}</span>
										</div>
										<div class="flex items-center gap-1">
											<span class="short-id truncate text-sm">{formatEncodedId(encoded)}</span>
											<button
												class="copy-button flex-none"
												on:click={() => copyToClipboard(encoded)}
												title="Copy encoded ID"
											>
												<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
													<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
												</svg>
											</button>
										</div>
									</div>
								</div>
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
	}

	:root {
		--table-bg: #ffffff;
		--table-border: #6b7280;
		--table-header-bg: #f3f4f6;
		--table-row-bg: #ffffff;
		--table-alt-row-bg: #f9fafb;
		--table-text: #000000;
	}

	/* Table styles */
	.table-container {
		background-color: var(--table-bg);
	}

	.table {
		@apply w-full border-collapse;
		background-color: var(--table-bg);
		border-color: var(--table-border);
		color: var(--table-text);
	}

	.table th {
		border: 1px solid var(--table-border);
		@apply p-2 text-left whitespace-nowrap;
		background-color: var(--table-header-bg);
	}

	.table td {
		border: 1px solid var(--table-border);
		@apply p-2 text-left whitespace-nowrap;
		background-color: var(--table-row-bg);
	}

	.table tr:nth-child(even) td {
		background-color: var(--table-alt-row-bg);
	}

	.card {
		border: 1px solid var(--table-border);
		background-color: var(--table-bg);
	}

	.input {
		background-color: var(--table-row-bg);
		border-color: var(--table-border);
		color: var(--table-text);
	}

	.copy-button {
		@apply opacity-50 hover:opacity-100 transition-opacity;
		@apply p-1 rounded;
		color: var(--table-text);
	}

	.copy-button:hover {
		background-color: color-mix(in srgb, var(--table-text) 20%, transparent);
	}

	.encoded-cell {
		position: relative;
	}

	.encoded-cell div {
		@apply w-full;
	}

	.encoded-cell .short-id {
		display: none;
	}

	.encoded-cell .full-id {
		display: block;
	}

	@media (max-width: 800px) {
		.encoded-cell .short-id {
			display: block;
		}
		.encoded-cell .full-id {
			display: none;
		}
		td:first-child {
			width: 50% !important;
		}
		td:last-child {
			width: 50% !important;
		}
		th:first-child {
			width: 50% !important;
		}
		th:last-child {
			width: 50% !important;
		}
	}
</style> 