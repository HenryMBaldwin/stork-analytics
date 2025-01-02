<script lang="ts">
	import { onMount } from 'svelte';
	import { writable, type Writable } from 'svelte/store';
	import { browser } from '$app/environment';

	let iframe: HTMLIFrameElement;

	// Try to get theme from window
	const themeMode: Writable<'light' | 'dark'> = writable('light');

	// Watch for theme changes in the DOM
	function observeTheme() {
		if (!browser) return;
		
		// Set initial theme
		const isDark = document.documentElement.classList.contains('dark');
		themeMode.set(isDark ? 'dark' : 'light');
		
		const observer = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				if (mutation.target === document.documentElement && mutation.attributeName === 'class') {
					const isDark = document.documentElement.classList.contains('dark');
					themeMode.set(isDark ? 'dark' : 'light');
				}
			});
		});

		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class']
		});

		return () => observer.disconnect();
	}

	// Handle iframe height messages and send theme updates
	onMount(() => {
		const handleMessage = (event: MessageEvent) => {
			console.log('Received message from iframe:', event.data);
			if (event.data?.type === 'resize' && event.data?.height) {
				if (iframe) {
					iframe.style.minHeight = `${event.data.height}px`;
				}
			} else if (event.data?.type === 'requestTheme') {
				const currentTheme = $themeMode;
				console.log('Current theme mode:', currentTheme);
				sendThemeToIframe(currentTheme === 'dark');
			}
		};

		window.addEventListener('message', handleMessage);

		// Set up theme observer
		const cleanup = observeTheme();

		// Send theme updates when it changes
		const unsubTheme = themeMode.subscribe((mode) => {
			console.log('Theme changed to:', mode);
			sendThemeToIframe(mode === 'dark');
		});

		// Send initial theme
		const initialTheme = $themeMode;
		console.log('Initial theme:', initialTheme);
		sendThemeToIframe(initialTheme === 'dark');

		return () => {
			window.removeEventListener('message', handleMessage);
			unsubTheme();
			cleanup?.();
		};
	});

	function sendThemeToIframe(isDark: boolean) {
		console.log('Sending theme to iframe:', isDark, 'Current theme mode:', $themeMode);
		if (iframe?.contentWindow) {
			iframe.contentWindow.postMessage({
				type: 'theme',
				isDark
			}, '*');
		}
	}
</script>

<div class="container mx-auto p-4">
	<iframe
		bind:this={iframe}
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