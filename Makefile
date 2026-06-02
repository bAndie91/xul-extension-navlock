
.PHONY: package
package: navlock.xpi

CONTENT_FILES = $(wildcard content/*)
LOCALE_FILES = $(wildcard locale/*/*)

navlock.xpi: install.rdf chrome.manifest $(CONTENT_FILES) $(LOCALE_FILES)
	-rm $@
	zip $@ $^
