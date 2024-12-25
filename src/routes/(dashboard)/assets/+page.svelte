<script lang="ts">
	import { onMount } from 'svelte';

	// Handle iframe height messages
	onMount(() => {
		const handleMessage = (event: MessageEvent) => {
			console.log('Received message:', event.data);
			if (event.data?.type === 'resize' && event.data?.height) {
				const iframe = document.querySelector('iframe');
				if (iframe) {
					console.log('Setting iframe min-height to:', event.data.height);
					iframe.style.minHeight = `${event.data.height}px`;
				} else {
					console.log('Iframe not found');
				}
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	});
</script>

<div class="container mx-auto p-4">
	<iframe
		src="/embeddable/asset-table"
		title="Asset Table"
		class="w-full border-none"
		style="min-height: 200px;"
	/>
</div>

<style>
	iframe {
		background: transparent;
		width: 100% !important;
	}
</style> 