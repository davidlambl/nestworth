import {
  ScrollViewStyleReset,
  useServerDocumentContext,
} from 'expo-router/html';
import type { PropsWithChildren } from 'react';

export default function Root({ children }: PropsWithChildren) {
  // Since SDK 58 the export hands the page its generated tags and the
  // JavaScript bundles through these: without bodyNodes the exported pages
  // load no script and never become interactive (#51).
  const { htmlAttributes, bodyAttributes, headNodes, bodyNodes } =
    useServerDocumentContext();
  return (
    <html lang="en" {...htmlAttributes}>
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
        <ScrollViewStyleReset />
        {headNodes}
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  );
}

const registerSW = `
if ('serviceWorker' in navigator && !/Electron/i.test(navigator.userAgent)) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js');
  });
}
`;
