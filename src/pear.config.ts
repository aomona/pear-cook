export const pearConfig = {
  appName: "PEAR Cook",
  domainId: "guided-cooking",
  apiBaseUrl: import.meta.env.VITE_PEAR_API_URL || window.location.origin,
} as const;
