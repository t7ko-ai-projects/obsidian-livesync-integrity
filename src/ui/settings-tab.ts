import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import { readLiveSyncCredentials } from "../livesync-credentials";
import type LiveSyncIntegrityPlugin from "../main";

function numberSetting(
	setting: Setting,
	value: number,
	min: number,
	onChange: (value: number) => Promise<void>,
): void {
	setting.addText((text) => {
		text.inputEl.type = "number";
		text.inputEl.min = String(min);
		text.setValue(String(value)).onChange(async (raw) => {
			const parsed = Number(raw);
			if (Number.isFinite(parsed) && parsed >= min) {
				await onChange(parsed);
			}
		});
	});
}

export class IntegritySettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: LiveSyncIntegrityPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		const creds = readLiveSyncCredentials(this.app);
		new Setting(containerEl)
			.setName("Connection")
			.setDesc(
				creds.ok
					? `Using LiveSync's bucket "${creds.creds.bucket}" (prefix "${creds.creds.bucketPrefix}"). Credentials are read from LiveSync at run time and never stored here.` +
							(creds.creds.endpoint.startsWith("http:")
								? " Warning: the endpoint is plain HTTP; manifests are encrypted, but the request signatures and bucket names travel unencrypted."
								: "")
					: `Not usable: ${creds.reason}`,
			);

		new Setting(containerEl)
			.setName("Device name")
			.setDesc(
				`Shown to other devices next to the id ${this.plugin.deviceId} (kept on this device only).`,
			)
			.addText((text) =>
				text.setValue(s.deviceName).onChange(async (value) => {
					s.deviceName = value.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Scheduled checks")
			.setDesc("Run automatically while Obsidian is open.")
			.addToggle((toggle) =>
				toggle.setValue(s.scheduleEnabled).onChange(async (value) => {
					s.scheduleEnabled = value;
					await save();
				}),
			);

		numberSetting(
			new Setting(containerEl)
				.setName("Interval (hours)")
				.setDesc("Time between scheduled checks."),
			s.intervalHours,
			1,
			async (value) => {
				s.intervalHours = value;
				await save();
			},
		);

		numberSetting(
			new Setting(containerEl)
				.setName("Quiet period (minutes)")
				.setDesc(
					"A scheduled check waits until no vault file changed for this long.",
				),
			s.quietMinutes,
			1,
			async (value) => {
				s.quietMinutes = value;
				await save();
			},
		);

		numberSetting(
			new Setting(containerEl)
				.setName("Grace window (minutes)")
				.setDesc(
					"A file changed more recently than this is not reported as a mismatch yet.",
				),
			s.graceMinutes,
			1,
			async (value) => {
				s.graceMinutes = value;
				await save();
			},
		);

		new Setting(containerEl)
			.setName("Excluded paths")
			.setDesc(
				"One regular expression per line, tested against the vault path. Keep them simple: a pattern with nested repetition such as (a+)+$ can stall the check.",
			)
			.addTextArea((area) =>
				area
					.setValue(s.excludePatterns.join("\n"))
					.onChange(async (value) => {
						s.excludePatterns = value
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean);
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Notify on new mismatches")
			.setDesc(
				"Show a notice when a check finds a mismatch not seen before.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(s.notifyOnNewMismatch)
					.onChange(async (value) => {
						s.notifyOnNewMismatch = value;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Daily digest")
			.setDesc(
				"On the first start of each day, show the files added, modified, renamed or deleted since the last digest. Only a window; nothing is written to the vault or the bucket.",
			)
			.addToggle((toggle) =>
				toggle.setValue(s.digestEnabled).onChange(async (value) => {
					s.digestEnabled = value;
					await save();
				}),
			)
			.addButton((button) =>
				button.setButtonText("Show now").onClick(() => {
					void this.plugin.showDigest(true);
				}),
			)
			.addButton((button) =>
				button.setButtonText("Reset baseline").onClick(async () => {
					await this.plugin.resetDigestBaseline();
					new Notice("Digest baseline cleared");
				}),
			);

		const seen = Object.keys(s.seenManifests);
		const knownDevices = new Setting(containerEl)
			.setName("Known devices")
			.setDesc(
				seen.length
					? `${seen.length} other device(s) seen so far. A device whose manifest disappears or goes back in time is reported; forget them after retiring a device.`
					: "No other device seen yet.",
			)
			.addButton((button) =>
				button.setButtonText("Forget all").onClick(async () => {
					await this.plugin.forgetDevices();
					knownDevices.setDesc("No other device seen yet.");
				}),
			);

		new Setting(containerEl)
			.setName("Check")
			.setDesc(
				s.lastRunAt
					? `Last run: ${new Date(s.lastRunAt).toLocaleString()}`
					: "Never run on this device.",
			)
			.addButton((button) =>
				button.setButtonText("Run now").onClick(() => {
					void this.plugin.runCheck(true);
				}),
			)
			.addButton((button) =>
				button.setButtonText("Show report").onClick(() => {
					this.plugin.showReport();
				}),
			);
	}
}
