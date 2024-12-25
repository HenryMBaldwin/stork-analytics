<!-- Create a standalone embeddable asset table -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { writable } from 'svelte/store';
	import { ethers } from 'ethers';
	import { browser } from '$app/environment';

	// Search query
	let searchQuery = '';

	// Store for asset data
	const assetStore = writable<[string, string][]>([]);

	// Format encoded ID to show first 6 and last 4 chars
	function formatEncodedId(encoded: string) {
		if (encoded.length <= 10) return encoded;
		return `${encoded.slice(0, 6)}...${encoded.slice(-4)}`;
	}

	// Filtered assets
	$: filteredAssets = $assetStore.filter(([plaintext]) => 
		!searchQuery || plaintext.toLowerCase().includes(searchQuery.toLowerCase())
	);

	// Send height to parent window
	function sendHeight() {
		if (!browser) return;
		const tableContainer = document.querySelector('.table-container');
		if (!tableContainer) {
			console.log('Table container not found');
			return;
		}
		
		const height = tableContainer.scrollHeight;
		console.log('Sending height:', height + 32);
		window.parent.postMessage({ type: 'resize', height: height + 32 }, '*');
	}

	// Update height when filtered results change
	$: if (browser) {
		filteredAssets;
		setTimeout(sendHeight, 0);
	}

	// Copy to clipboard function
	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch (err) {
			console.error('Failed to copy text: ', err);
		}
	}

	// Fetch assets and set up resize observer
	onMount(() => {
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

		const resizeObserver = new ResizeObserver(sendHeight);
		const tableContainer = document.querySelector('.table-container');
		if (tableContainer) {
			resizeObserver.observe(tableContainer);
		}

		return () => resizeObserver.disconnect();
	});
</script>

<div class="table-container p-4">
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

	/* Table styles */
	.table {
		@apply w-full border-collapse;
	}

	.table th,
	.table td {
		@apply border border-secondary-500 p-2;
		@apply text-left;
		@apply whitespace-nowrap;
	}

	.encoded-cell {
		position: relative;
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

	.card {
		@apply border border-secondary-500;
	}

	:global(.dark) .table {
		@apply border-primary-900 bg-surface-700;
	}

	:global(.dark) .table th {
		@apply border-primary-900 bg-surface-800;
	}

	:global(.dark) .table td {
		@apply border-primary-900 bg-surface-700;
	}

	:global(.dark) .table tr:nth-child(even) td {
		@apply bg-surface-800;
	}

	:global(.dark) .card {
		@apply border-primary-900;
	}

	.copy-button {
		@apply opacity-50 hover:opacity-100 transition-opacity;
		@apply p-1 rounded hover:bg-surface-500/20;
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