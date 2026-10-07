# Microsoft Store publication

The current download is a portable Windows application. No Store submission has been created. MSIX is the recommended packaging route.

1. Register and verify a developer account at https://storedeveloper.microsoft.com and reserve the app name.
2. Obtain the reserved package identity and publisher identity from Partner Center.
3. Package the x64 desktop application as MSIX using those identities. Microsoft signs accepted Store packages; a purchased signing certificate is not required for this route.
4. Test installation, updates, removal, data persistence, notifications, tray behavior and the assistant connection on clean Windows machines. Verify installed paths and packaged app data behavior.
5. Prepare the app logo, screenshots, support contact, privacy policy, age rating, markets, pricing and accurate feature description.
6. Create a submission in Partner Center, upload the package and listing assets, include reviewer instructions, submit for certification and address reported failures.
7. Publish after acceptance and verify installation through the Store.

Do not submit the current preview as a complete live market-data product. Market-value reconciliation and measured activity coverage remain incomplete.

An alternative MSI/EXE route requires a signed standalone installer with silent installation support hosted at an immutable versioned HTTPS URL. The portable application executable is not such an installer.

The Store receives compiled application packages, not repository source code. Existing public repository contents remain public separately.

Official references:

- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/upload-app-packages
