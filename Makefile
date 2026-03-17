UUID := backlight-controller@jonas
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES := metadata.json extension.js prefs.js logic.js README.md

.PHONY: install enable disable remove reinstall test

install:
	mkdir -p "$(EXT_DIR)"
	cp -r $(FILES) "$(EXT_DIR)/"
	@echo "Installed to $(EXT_DIR)"
	@echo "Enable with: gnome-extensions enable $(UUID)"

enable:
	gnome-extensions enable "$(UUID)"
	@echo "Enabled $(UUID)"

disable:
	gnome-extensions disable "$(UUID)"
	@echo "Disabled $(UUID)"

remove:
	test "$(EXT_DIR)" = "$(HOME)/.local/share/gnome-shell/extensions/$(UUID)"
	rm -rf -- "$(EXT_DIR)"
	@echo "Removed $(EXT_DIR)"

reinstall: disable install enable
	@echo "Reinstalled $(UUID)"

test:
	gjs -m tests/logic.test.js
