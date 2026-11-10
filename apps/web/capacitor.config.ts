const config = {
  appId: "com.medveris.app",
  appName: "Medveris",
  webDir: "dist",
  server: {
    // For live-reload during native development set CAPACITOR_SERVER_URL, e.g. http://10.0.2.2:5173
    url: process.env.CAPACITOR_SERVER_URL,
    cleartext: process.env.CAPACITOR_SERVER_URL ? true : undefined,
    androidScheme: "https",
  },
  ios: {
    contentInset: "automatic",
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
