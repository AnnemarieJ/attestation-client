systemctl --user stop indexer-doge.service
CONFIG_PATH=.secure node dist/lib/runIndexer -a DOGE -r RESET_ACTIVE
systemctl --user start indexer-doge.service
