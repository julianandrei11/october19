// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

export const environment = {
  production: false,
  firebase: {
    apiKey: "AIzaSyCFEhblGz5QgfKTVMI7rRpV5MB6ulALmRI",
    authDomain: "alala-bfa00.firebaseapp.com",
    projectId: "alala-bfa00",
    storageBucket: "alala-bfa00.firebasestorage.app",
    messagingSenderId: "1016035805757",
    appId: "1:1016035805757:web:aaf943b0885ff96a7a3854"
  },
  cloudinary: {
    cloudName: "doypcw87t",
    apiKey: "857239921428748",
    apiSecret: "KFSndAL-p6wCrx_5ePD-n9XUgbc",
    uploadPreset: "ml_default"
  }
};

/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.