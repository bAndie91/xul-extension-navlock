
.PHONY: package
package: navlock.xpi

navlock.xpi: bootstrap.js install.rdf
	-rm $@
	zip $@ $^
