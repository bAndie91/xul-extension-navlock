
.PHONY: package
package: navlock.xpi

CONTENT_FILES = $(wildcard chrome/content/*)
LOCALE_FILES = $(wildcard locale/*/*)

navlock.xpi: install.rdf chrome.manifest $(CONTENT_FILES) $(LOCALE_FILES) defaults/preferences/navlock.js
	-rm $@
	zip $@ $^
