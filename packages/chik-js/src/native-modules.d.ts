declare module "react-native-keychain" {
  export function getGenericPassword(options?: { service?: string }): Promise<false | { password: string }>;
  export function setGenericPassword(username: string, password: string, options?: { service?: string }): Promise<boolean>;
  export function resetGenericPassword(options?: { service?: string }): Promise<boolean>;
}

declare module "react-native" {
  export const ActivityIndicator: unknown;
  export const Button: unknown;
  export const Linking: {
    openURL(url: string): Promise<unknown>;
    getInitialURL(): Promise<string | null>;
    addEventListener(name: "url", listener: (event: { url: string }) => void): { remove(): void };
  };
  export const Modal: unknown;
  export const NativeModules: {
    readonly ChikCheckoutLauncher?: {
      openPackages(url: string, packageNames: readonly string[]): Promise<boolean>;
    };
    readonly [name: string]: unknown;
  };
  export const Platform: { OS: "android" | "ios" | string };
  export const View: unknown;
}

declare module "react" {
  export interface ReactElement {}
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): ReactElement;
  export function useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
}

declare module "react-native-webview" {
  export const WebView: unknown;
}

declare module "expo-secure-store" {
  export function getItemAsync(key: string): Promise<string | null>;
  export function setItemAsync(key: string, value: string): Promise<void>;
  export function deleteItemAsync(key: string): Promise<void>;
}

declare module "expo-web-browser" {
  export function openAuthSessionAsync(url: string, redirectUrl: string, options?: { preferUniversalLinks?: boolean }): Promise<{ type: string; url?: string }>;
}
