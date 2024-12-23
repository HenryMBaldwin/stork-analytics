<script lang="ts">
	import { enhance } from '$app/forms';
	import { ethers } from 'ethers';
	import { writable, type Writable } from 'svelte/store';
	import { onDestroy } from 'svelte';
	
	let chainId: string = '';
	let contractAddress: string = '';
	let loading = false;
	let progress = '';
	let error: string | null = null;
	let wsProvider: ethers.WebSocketProvider | null = null;
	let currentChainName: string = '';
	let abortController: AbortController | null = null;

	// Create a writable store for transactions
	const transactionStore: Writable<any[]> = writable([]);
	
	// Add a transaction to the store
	function addTransaction(tx: any) {
		if (!tx) return;
		
		// Only keep creation and incoming transactions
		if (!tx.to || tx.to.toLowerCase() === contractAddress.toLowerCase()) {
			transactionStore.update(txs => {
				// Check if we already have this transaction
				if (!txs.find(t => t.hash === tx.hash)) {
					return [tx, ...txs].sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0));
				}
				return txs;
			});
		}
	}

	// Subscribe to new events
	function subscribeToEvents(provider: ethers.WebSocketProvider) {
		try {
			const filter = {
				address: contractAddress,
				topics: []
			};
			
			provider.on(filter, async (log) => {
				if (!log.transactionHash) return;
				
				try {
					const tx = await provider.getTransaction(log.transactionHash);
					addTransaction(tx);
				} catch (e) {
					console.warn('Error fetching new transaction:', e);
				}
			});
			
			console.log('Subscribed to new events');
		} catch (e) {
			console.error('Error setting up event subscription:', e);
		}
	}

	async function fetchTransactions() {
		loading = true;
		error = null;
		transactionStore.set([]);
		currentChainName = '';
		abortController = new AbortController();
		
		try {
			progress = 'Fetching chain info...';
			const chainlistResponse = await fetch(`https://chainid.network/chains.json`);
			const chains = await chainlistResponse.json();
			const chain = chains.find((c: any) => c.chainId === parseInt(chainId));
			
			if (!chain) {
				throw new Error(`Chain ID ${chainId} not found`);
			}

			currentChainName = chain.name;
			console.log('Using chain:', chain.name);
			
			// Setup providers
			const rpcUrl = chain.rpc[0];
			const provider = new ethers.JsonRpcProvider(rpcUrl);
			
			// Try to set up websocket if available
			const wsUrl = chain.rpc.find((url: string) => url.startsWith('wss://'));
			if (wsUrl) {
				try {
					wsProvider?.destroy();
					wsProvider = new ethers.WebSocketProvider(wsUrl);
					subscribeToEvents(wsProvider);
				} catch (e) {
					console.warn('Failed to setup websocket:', e);
				}
			}
			
			progress = 'Getting latest block...';
			const latestBlock = await provider.getBlockNumber();
			console.log('Latest block:', latestBlock);
			
			let chunkSize = 100_000;
			let consecutiveSuccesses = 0;
			let consecutiveFailures = 0;
			let foundCreation = false;
			
			// Search backwards in chunks until we find the contract creation
			for (let block = latestBlock; block > 0 && !abortController?.signal.aborted; block -= chunkSize) {
				const fromBlock = Math.max(0, block - chunkSize);
				progress = `Fetching logs for blocks ${fromBlock.toLocaleString()} to ${block.toLocaleString()} of ${latestBlock.toLocaleString()}...`;
				
				try {
					const logs = await provider.getLogs({
						address: contractAddress,
						fromBlock,
						toBlock: block
					});
					
					console.log(`Found ${logs.length} logs in range ${fromBlock}-${block}`);
					
					const txHashes = [...new Set(logs.map(log => log.transactionHash).filter(Boolean))];
					const BATCH_SIZE = 20;
					const batches = [];
					for (let i = 0; i < txHashes.length; i += BATCH_SIZE) {
						const batch = txHashes.slice(i, i + BATCH_SIZE);
						batches.push(batch);
					}

					for (const batch of batches) {
						const [txs, receipts] = await Promise.all([
							Promise.all(batch.map(hash => provider.getTransaction(hash))),
							Promise.all(batch.map(hash => provider.getTransactionReceipt(hash)))
						]);
						
						// Add transactions to store as they come in
						txs.forEach(addTransaction);
						
						// Check for contract creation
						for (const receipt of receipts) {
							if (receipt?.contractAddress?.toLowerCase() === contractAddress.toLowerCase()) {
								console.log('Found contract creation at block:', receipt.blockNumber);
								foundCreation = true;
								break;
							}
						}
						
						if (foundCreation) break;
					}
					
					if (foundCreation) break;
					
					consecutiveSuccesses++;
					consecutiveFailures = 0;
					if (consecutiveSuccesses >= 2) {
						const newChunkSize = Math.min(500_000, Math.floor(chunkSize * 1.5));
						if (newChunkSize !== chunkSize) {
							console.log(`Increasing chunk size to ${newChunkSize}`);
							chunkSize = newChunkSize;
							consecutiveSuccesses = 0;
						}
					}
					
				} catch (e: any) {
					console.warn(`Error in chunk ${fromBlock}-${block}:`, e?.message || e);
					block += chunkSize;
					consecutiveFailures++;
					consecutiveSuccesses = 0;
					
					const reduction = consecutiveFailures > 2 ? 4 : 2;
					chunkSize = Math.max(1000, Math.floor(chunkSize / reduction));
					console.log(`Reducing chunk size to ${chunkSize} after ${consecutiveFailures} failures`);
					block -= chunkSize;
					
					if (consecutiveFailures > 3) {
						console.log('Too many failures, adding delay...');
						await new Promise(resolve => setTimeout(resolve, 1000));
					}
					continue;
				}
			}
			
		} catch (e: any) {
			console.error('Error in fetchTransactions:', e);
			error = e.message;
		} finally {
			loading = false;
			abortController = null;
		}
	}

	function cancelFetch() {
		if (abortController) {
			abortController.abort();
		}
		wsProvider?.destroy();
		wsProvider = null;
	}

	// Cleanup on component destroy
	onDestroy(() => {
		wsProvider?.destroy();
	});
</script>

<div class="container mx-auto p-4 space-y-8">
	<h1 class="h1">Contract Transaction Dashboard</h1>
	
	<div class="card p-4">
		<form class="space-y-4" on:submit|preventDefault={fetchTransactions}>
			<div class="space-y-2">
				<label class="label" for="chainId">
					<span>Chain ID</span>
				</label>
				<input
					class="input"
					type="text"
					id="chainId"
					bind:value={chainId}
					placeholder="e.g. 1 for Ethereum Mainnet"
					required
				/>
			</div>
			
			<div class="space-y-2">
				<label class="label" for="contractAddress">
					<span>Contract Address</span>
				</label>
				<input
					class="input"
					type="text"
					id="contractAddress"
					bind:value={contractAddress}
					placeholder="0x..."
					required
				/>
			</div>
			
			<div class="flex gap-4">
				<button type="submit" class="btn variant-filled-primary" disabled={loading}>
					{loading ? 'Loading...' : 'Fetch Transactions'}
				</button>
				{#if loading}
					<button type="button" class="btn variant-filled-error" on:click={cancelFetch}>
						Cancel
					</button>
				{/if}
			</div>
		</form>
	</div>
	
	{#if loading}
		<div class="card p-4">
			<div class="flex items-center space-x-4">
				<div class="spinner-border" role="status"></div>
				<span>{progress}</span>
			</div>
		</div>
	{/if}
	
	{#if error}
		<div class="alert variant-filled-error">
			{error}
		</div>
	{/if}
	
	{#if !loading && $transactionStore.length === 0 && !error}
		<div class="card p-4">
			<div class="text-center text-gray-500">
				No transactions found for {currentChainName || 'this contract'}.
			</div>
		</div>
	{/if}
	
	{#if $transactionStore.length > 0}
		<div class="card p-4">
			<h2 class="h2">Transactions ({$transactionStore.length})</h2>
			<div class="table-container">
				<table class="table table-compact">
					<thead>
						<tr>
							<th>Block</th>
							<th>Hash</th>
							<th>From</th>
							<th>Type</th>
							<th>Raw Data</th>
						</tr>
					</thead>
					<tbody>
						{#each $transactionStore as tx}
							<tr>
								<td>{tx.blockNumber}</td>
								<td class="font-mono text-xs break-all whitespace-normal">{tx.hash}</td>
								<td class="font-mono break-all">{tx.from}</td>
								<td>{!tx.to ? 'Creation' : 'Incoming'}</td>
								<td class="font-mono break-all">
									<div class="max-h-32 overflow-y-auto">
										{tx.data}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>

<style>
	.table-container {
		@apply overflow-x-auto;
	}
	
	.spinner-border {
		@apply w-8 h-8 border-4 border-primary-500 border-r-transparent rounded-full animate-spin;
	}
</style>
