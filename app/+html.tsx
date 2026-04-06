import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        <meta name="theme-color" content="#15803d" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <script dangerouslySetInnerHTML={{ __html: registerSW }} />
        <style dangerouslySetInnerHTML={{ __html: responsiveCSS }} />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}

const registerSW = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js');
  });
}
`;

const responsiveCSS = `
@media (min-width: 768px) {
  body {
    background-color: #111;
  }
  #root {
    max-width: 480px;
    margin: 0 auto;
    min-height: 100vh;
    box-shadow: 0 0 40px rgba(0,0,0,0.3);
    overflow: hidden;
  }
}
@media (min-width: 768px) and (prefers-color-scheme: light) {
  body {
    background-color: #e5e5e5;
  }
  #root {
    box-shadow: 0 0 40px rgba(0,0,0,0.1);
  }
}
`;
