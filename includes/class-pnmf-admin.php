<?php
/**
 * PlugNest Media Folders — 後台管理頁面。
 *
 * @package PlugNest Media Folders
 */

defined( 'ABSPATH' ) || exit;

class PNMF_Admin {

	/** @var PNMF_Admin|null */
	private static $instance = null;

	/** 選單 slug。 */
	const SLUG = 'plugnest-media-folders';

	/** @return PNMF_Admin */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( 'admin_menu', array( $this, 'menu' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'assets' ) );
		add_action( 'enqueue_block_editor_assets', array( $this, 'block_editor_assets' ) );
	}

	/**
	 * 選單項目。
	 *
	 * 圖標用外掛自帶的原創 nest SVG（data URI）：後台深淺色側欄都清晰，
	 * 不依賴 dashicons、也沒有版權顧慮。
	 */
	public function menu() {
		$icon = 'dashicons-images-alt2';
		$svg  = PNMF_PATH . 'assets/icon.svg';
		if ( is_readable( $svg ) ) {
			$icon = 'data:image/svg+xml;base64,' . base64_encode( (string) file_get_contents( $svg ) );
		}

		add_menu_page(
			__( 'PlugNest Media Folders', 'plugnest-media-folders' ),
			__( 'PlugNest Media Folders', 'plugnest-media-folders' ),
			'upload_files',
			self::SLUG,
			array( $this, 'render_page' ),
			$icon,
			58
		);
	}

	/**
	 * 是否為本外掛頁面。
	 *
	 * @return bool
	 */
	private function is_plugin_page() {
		return isset( $_GET['page'] ) && self::SLUG === $_GET['page']; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
	}

	/**
	 * 載入資源。
	 *
	 * @param string $hook
	 */
	public function assets( $hook ) {
		if ( ! $this->is_plugin_page() ) {
			return;
		}

		/*
		 * 頁內上傳（方案 A）：確保核心媒體腳本與 _wpMediaViewsL10n（上傳 nonce、
		 * 大小上限、mime 白名單）都在 —— 沒有這個，開出來的媒體框無法上傳。
		 * 頁面上本來就有部分媒體腳本（wp.media / plupload），wp_enqueue_media()
		 * 補的是設定與缺的 handle；已載入的重複 handle 不會印第二次。
		 */
		if ( current_user_can( 'upload_files' ) ) {
			wp_enqueue_media();
		}

		wp_enqueue_style(
			'pnmf-admin',
			PNMF_URL . 'assets/css/admin.css',
			array(),
			PNMF_Plugin::asset_ver( 'assets/css/admin.css' )
		);

		wp_enqueue_script(
			'pnmf-admin',
			PNMF_URL . 'assets/js/admin.js',
			array( 'wp-i18n' ),
			PNMF_Plugin::asset_ver( 'assets/js/admin.js' ),
			true
		);
		wp_set_script_translations( 'pnmf-admin', 'plugnest-media-folders', PNMF_PATH . 'languages' );

		wp_localize_script(
			'pnmf-admin',
			'PNMF',
			array(
				'ajaxUrl'     => admin_url( 'admin-ajax.php' ),
				'nonce'       => wp_create_nonce( 'pnmf' ),
				'uploadNonce' => wp_create_nonce( PNMF_Upload::NONCE_ACTION ),
				'pro'         => PNMF_Plugin::is_pro() ? 1 : 0,
				'buyUrl'      => 'https://media-folders.plugnest.dev/',
				'proFeatures' => array(
					__( 'Unused-media cleanup wizard', 'plugnest-media-folders' ),
					__( 'Missing-alt batch workflow', 'plugnest-media-folders' ),
					__( 'Folder import/export & import from other folder plugins', 'plugnest-media-folders' ),
					__( 'Folder access roles', 'plugnest-media-folders' ),
					__( 'Delete folder together with its files (typed confirmation)', 'plugnest-media-folders' ),
				),
				'roles'       => PNMF_Taxonomy::get_role_names(),
				'perPage'     => 60,
				'folders'     => PNMF_Taxonomy::visible_folder_tree( true ),
				'tags'        => $this->get_tags(),
				'stats'       => PNMF_Query::stats(),
				'rules'       => PNMF_Auto::get_rules(),
				'folderPaths' => PNMF_Auto::get_folder_paths(),
				'editUrl'     => admin_url( 'post.php' ),
				'uploadUrl'   => admin_url( 'upload.php' ),
				'strings'     => array(
					'confirmDeleteFolder' => __( 'Delete this folder?

Media and physical files inside are kept; subfolders move up one level.', 'plugnest-media-folders' ),
					'confirmDeleteTag'    => __( 'Delete this tag? The media itself is not affected.', 'plugnest-media-folders' ),
					'confirmApply'        => __( 'Apply auto-assign? You can undo it from Activity Log afterwards.', 'plugnest-media-folders' ),
					'noSelection'         => __( 'Select some media first.', 'plugnest-media-folders' ),
					'loading'             => __( 'Loading…', 'plugnest-media-folders' ),
					'noResult'            => __( 'No media matches the current filters.', 'plugnest-media-folders' ),
				),
			)
		);
	}

	/**
	 * 標籤清單。
	 *
	 * @return array
	 */
	private function get_tags() {
		$terms = get_terms(
			array(
				'taxonomy'   => PNMF_TAX_TAG,
				'hide_empty' => false,
			)
		);
		$out = array();
		if ( is_wp_error( $terms ) ) {
			return $out;
		}
		foreach ( $terms as $t ) {
			$out[] = array(
				'term_id' => (int) $t->term_id,
				'name'    => $t->name,
				'count'   => (int) $t->count,
			);
		}
		return $out;
	}

	/**
	 * Gutenberg 編輯器資源：文件設定側欄的「媒體資料夾」面板。
	 */
	public function block_editor_assets() {
		if ( ! current_user_can( 'upload_files' ) ) {
			return;
		}

		wp_enqueue_script(
			'pnmf-gutenberg',
			PNMF_URL . 'assets/js/gutenberg.js',
			array( 'wp-plugins', 'wp-edit-post', 'wp-element', 'wp-data', 'wp-i18n' ),
			PNMF_Plugin::asset_ver( 'assets/js/gutenberg.js' ),
			true
		);
		wp_set_script_translations( 'pnmf-gutenberg', 'plugnest-media-folders', PNMF_PATH . 'languages' );

		wp_localize_script(
			'pnmf-gutenberg',
			'PNMF_GUT',
			array(
				'ajaxUrl' => admin_url( 'admin-ajax.php' ),
				'nonce'   => wp_create_nonce( 'pnmf' ),
				'folders' => PNMF_Taxonomy::visible_folder_tree( true ),
			)
		);
	}

	/**
	 * 頁面骨架。
	 */
	public function render_page() {
		if ( ! current_user_can( 'upload_files' ) ) {
			wp_die( esc_html__( 'Your account does not have permission to manage media.', 'plugnest-media-folders' ) );
		}
		?>
		<div class="wrap pnmf-wrap">

			<div class="pnmf-header">
				<div class="pnmf-header-left">
					<h1 class="pnmf-title">
						<?php esc_html_e( 'PlugNest Media Folders', 'plugnest-media-folders' ); ?>
						<span class="pnmf-safe-badge" title="<?php esc_attr_e( 'This plugin only writes classification data; it never moves or rewrites media files.', 'plugnest-media-folders' ); ?>"><?php esc_html_e( 'File paths untouched', 'plugnest-media-folders' ); ?></span>
					</h1>
					<p class="pnmf-sub"><?php esc_html_e( 'Organize media with folders and tags. Everything writes to the database only — media URLs and physical files never change.', 'plugnest-media-folders' ); ?></p>
				</div>
				<div class="pnmf-header-actions">
					<button type="button" class="button button-primary" id="pnmf-btn-upload">
						<span class="dashicons dashicons-upload"></span> <?php esc_html_e( 'Upload media', 'plugnest-media-folders' ); ?>
					</button>
					<?php $pnmf_pro_locked = PNMF_Plugin::is_pro() ? '' : ' pnmf-pro-locked'; ?>
					<button type="button" class="button<?php echo esc_attr( $pnmf_pro_locked ); ?>" id="pnmf-btn-cleanup" title="<?php esc_attr_e( 'Pro feature', 'plugnest-media-folders' ); ?>">
						<span class="dashicons dashicons-editor-unlink"></span> <?php esc_html_e( 'Clean up unused', 'plugnest-media-folders' ); ?>
					</button>
					<button type="button" class="button<?php echo esc_attr( $pnmf_pro_locked ); ?>" id="pnmf-btn-alt" title="<?php esc_attr_e( 'Pro feature', 'plugnest-media-folders' ); ?>">
						<span class="dashicons dashicons-universal-access-alt"></span> <?php esc_html_e( 'Missing alt', 'plugnest-media-folders' ); ?>
					</button>
					<button type="button" class="button" id="pnmf-btn-scan">
						<span class="dashicons dashicons-search"></span> <?php esc_html_e( 'Scan usage', 'plugnest-media-folders' ); ?>
					</button>
					<button type="button" class="button" id="pnmf-btn-auto">
						<span class="dashicons dashicons-networking"></span> <?php esc_html_e( 'Auto-assign', 'plugnest-media-folders' ); ?>
					</button>
					<button type="button" class="button" id="pnmf-btn-logs">
						<span class="dashicons dashicons-backup"></span> <?php esc_html_e( 'Activity log', 'plugnest-media-folders' ); ?>
					</button>
				</div>
			</div>

			<div class="pnmf-stats" id="pnmf-stats"></div>

			<!-- ============ 頁內上傳列（方案 B：拖放區） ============ -->
			<div class="pnmf-uploadbar" id="pnmf-upload-dropzone">
				<button type="button" class="button button-primary" id="pnmf-upload-browse">
					<span class="dashicons dashicons-upload"></span> <?php esc_html_e( 'Select files to upload', 'plugnest-media-folders' ); ?>
				</button>
				<span class="pnmf-uploadbar-hint">
					<?php
					/* 提示內含強調標籤，拆成三段輸出。 */
					echo esc_html__( 'Or drop files here — actually', 'plugnest-media-folders' ) . ' <strong>' . esc_html__( 'the whole page is a dropzone', 'plugnest-media-folders' ) . '</strong>: ' . esc_html__( 'drop onto a folder row and the files land in that folder; drop anywhere else and they land in', 'plugnest-media-folders' ) . ' <strong id="pnmf-upload-target">' . esc_html__( 'the folder you are browsing', 'plugnest-media-folders' ) . '</strong>' . esc_html__( ' (it follows the folder selected on the left).', 'plugnest-media-folders' );
					?>
				</span>
				<div class="pnmf-uploadbar-progress" id="pnmf-upload-progress" hidden>
					<span class="pnmf-uploadbar-progress-text" id="pnmf-upload-progress-text"></span>
					<div class="pnmf-progress-bar"><span id="pnmf-upload-progress-fill"></span></div>
				</div>
			</div>

			<!-- ============ 資料夾樹的資料夾列動作由 JS 生成；roles 鈕為 🔒 ============ -->

			<div class="pnmf-layout">

				<!-- ============ 左：資料夾樹 ============ -->
				<aside class="pnmf-panel pnmf-sidebar">
					<div class="pnmf-panel-head">
						<span><?php esc_html_e( 'Folders', 'plugnest-media-folders' ); ?></span>
					<button type="button" class="pnmf-icon-btn" id="pnmf-add-folder" title="<?php esc_attr_e( 'Add new folder', 'plugnest-media-folders' ); ?>">＋</button>
						</div>
					<div class="pnmf-exportbar">
						<button type="button" class="button-link pnmf-mini-link<?php echo esc_attr( $pnmf_pro_locked ); ?>" id="pnmf-export-folders"><?php esc_html_e( 'Export', 'plugnest-media-folders' ); ?></button>
						<span>·</span>
						<button type="button" class="button-link pnmf-mini-link<?php echo esc_attr( $pnmf_pro_locked ); ?>" id="pnmf-import-folders"><?php esc_html_e( 'Import', 'plugnest-media-folders' ); ?></button>
						<span>·</span>
						<button type="button" class="button-link pnmf-mini-link<?php echo esc_attr( $pnmf_pro_locked ); ?>" id="pnmf-import-plugins"><?php esc_html_e( 'From plugins', 'plugnest-media-folders' ); ?></button>
					</div>
								<ul class="pnmf-tree" id="pnmf-tree"></ul>

					<div class="pnmf-panel-head pnmf-panel-head--sub">
						<span><?php esc_html_e( 'Tags', 'plugnest-media-folders' ); ?></span>
						<button type="button" class="pnmf-icon-btn" id="pnmf-add-tag" title="<?php esc_attr_e( 'Add new tag', 'plugnest-media-folders' ); ?>">＋</button>
					</div>
					<div class="pnmf-tags" id="pnmf-tags"></div>
				</aside>

				<!-- ============ 中：媒體網格 ============ -->
				<section class="pnmf-panel pnmf-main">

					<div class="pnmf-toolbar">
						<input type="search" id="pnmf-search" class="pnmf-search" placeholder="<?php esc_attr_e( 'Search filename or title…', 'plugnest-media-folders' ); ?>">

						<select id="pnmf-type">
							<option value=""><?php esc_html_e( 'All types', 'plugnest-media-folders' ); ?></option>
							<option value="image"><?php esc_html_e( 'Image', 'plugnest-media-folders' ); ?></option>
							<option value="audio"><?php esc_html_e( 'Audio', 'plugnest-media-folders' ); ?></option>
							<option value="video"><?php esc_html_e( 'Video', 'plugnest-media-folders' ); ?></option>
							<option value="document"><?php esc_html_e( 'Document', 'plugnest-media-folders' ); ?></option>
						</select>

						<select id="pnmf-usage">
							<option value=""><?php esc_html_e( 'Usage status: All', 'plugnest-media-folders' ); ?></option>
							<option value="used"><?php esc_html_e( 'In use', 'plugnest-media-folders' ); ?></option>
							<option value="unused"><?php esc_html_e( 'Unused', 'plugnest-media-folders' ); ?></option>
							<option value="unscanned"><?php esc_html_e( 'Not scanned', 'plugnest-media-folders' ); ?></option>
						</select>

						<select id="pnmf-sort">
							<option value="date-DESC"><?php esc_html_e( 'Newest first', 'plugnest-media-folders' ); ?></option>
							<option value="date-ASC"><?php esc_html_e( 'Oldest first', 'plugnest-media-folders' ); ?></option>
							<option value="title-ASC"><?php esc_html_e( 'Title A→Z', 'plugnest-media-folders' ); ?></option>
							<option value="title-DESC"><?php esc_html_e( 'Title Z→A', 'plugnest-media-folders' ); ?></option>
							<option value="size-DESC"><?php esc_html_e( 'File size high→low', 'plugnest-media-folders' ); ?></option>
							<option value="size-ASC"><?php esc_html_e( 'File size low→high', 'plugnest-media-folders' ); ?></option>
							<option value="ID-DESC"><?php esc_html_e( 'ID high→low', 'plugnest-media-folders' ); ?></option>
						</select>

						<label class="pnmf-check">
							<input type="checkbox" id="pnmf-include-children" checked>
							<?php esc_html_e( 'Include subfolders', 'plugnest-media-folders' ); ?>
						</label>

						<div class="pnmf-view-toggle" role="group" aria-label="<?php esc_attr_e( 'View mode', 'plugnest-media-folders' ); ?>">
							<button type="button" id="pnmf-view-grid" class="pnmf-view-btn" title="<?php esc_attr_e( 'Grid view', 'plugnest-media-folders' ); ?>">
								<span class="dashicons dashicons-grid-view"></span>
							</button>
							<button type="button" id="pnmf-view-list" class="pnmf-view-btn" title="<?php esc_attr_e( 'List view', 'plugnest-media-folders' ); ?>">
								<span class="dashicons dashicons-list-view"></span>
							</button>
						</div>

						<p class="pnmf-marquee-hint">
							<?php esc_html_e( 'Hold and drag on empty space, or press a card briefly and drag, to box-select multiple items. Hold Ctrl/Cmd while dragging to add to the selection.', 'plugnest-media-folders' ); ?>
							<?php esc_html_e( 'Drag cards onto a folder on the left to move them (multi-select works); drop on "Unassigned" to remove folders.', 'plugnest-media-folders' ); ?>
						</p>
					</div>

					<!-- 批次操作列 -->
					<div class="pnmf-bulkbar" id="pnmf-bulkbar" hidden>
						<div class="pnmf-bulkbar-count">
							<?php esc_html_e( 'Selected', 'plugnest-media-folders' ); ?> <strong id="pnmf-selected-count">0</strong>
							<button type="button" class="pnmf-link" id="pnmf-select-all"><?php esc_html_e( 'Select all matching', 'plugnest-media-folders' ); ?></button>
							<button type="button" class="pnmf-link" id="pnmf-clear-selection"><?php esc_html_e( 'Clear selection', 'plugnest-media-folders' ); ?></button>
						</div>

						<div class="pnmf-bulkbar-row">
							<div class="pnmf-field">
								<label><?php esc_html_e( 'Folder', 'plugnest-media-folders' ); ?></label>
								<select id="pnmf-bulk-folder"></select>
							</div>
							<button type="button" class="button button-primary" data-bulk="folder-move"><?php esc_html_e( 'Move to', 'plugnest-media-folders' ); ?></button>
							<button type="button" class="button" data-bulk="folder-add"><?php esc_html_e( 'Add', 'plugnest-media-folders' ); ?></button>
							<button type="button" class="button" data-bulk="folder-clear"><?php esc_html_e( 'Remove from folders', 'plugnest-media-folders' ); ?></button>
							<button type="button" class="button pnmf-danger-btn" data-bulk="media-delete" title="<?php esc_attr_e( 'Delete permanently (skips trash, cannot be undone)', 'plugnest-media-folders' ); ?>"><?php esc_html_e( 'Delete permanently', 'plugnest-media-folders' ); ?></button>
						</div>

						<div class="pnmf-bulkbar-row">
							<div class="pnmf-field">
								<label><?php esc_html_e( 'Tags', 'plugnest-media-folders' ); ?></label>
								<input type="text" id="pnmf-bulk-tags" placeholder="<?php esc_attr_e( 'Comma-separated; missing tags are created', 'plugnest-media-folders' ); ?>">
							</div>
							<button type="button" class="button" data-bulk="tag-add"><?php esc_html_e( 'Add tags', 'plugnest-media-folders' ); ?></button>
							<button type="button" class="button" data-bulk="tag-remove"><?php esc_html_e( 'Remove tags', 'plugnest-media-folders' ); ?></button>
						</div>

						<div class="pnmf-bulkbar-row pnmf-bulkbar-row--edit">
							<button type="button" class="button" id="pnmf-toggle-edit">
								<?php esc_html_e( 'Batch edit fields', 'plugnest-media-folders' ); ?> <span class="dashicons dashicons-arrow-down-alt2"></span>
							</button>
						</div>

						<div class="pnmf-bulk-edit" id="pnmf-bulk-edit" hidden>
							<p class="pnmf-hint">
								<?php esc_html_e( 'Variables:', 'plugnest-media-folders' ); ?> <code>{filename}</code> <?php esc_html_e( 'full filename', 'plugnest-media-folders' ); ?>,
								<code>{stem}</code> <?php esc_html_e( 'filename without extension', 'plugnest-media-folders' ); ?>,
								<code>{ext}</code> <?php esc_html_e( 'extension', 'plugnest-media-folders' ); ?>,
								<code>{index}</code> <?php esc_html_e( 'counter', 'plugnest-media-folders' ); ?>,
								<code>{original}</code> <?php esc_html_e( 'original value', 'plugnest-media-folders' ); ?>.
								<?php esc_html_e( 'Empty fields are left unchanged.', 'plugnest-media-folders' ); ?>
							</p>
							<div class="pnmf-field-grid">
								<label><?php esc_html_e( 'Title', 'plugnest-media-folders' ); ?> <input type="text" id="pnmf-edit-title" placeholder="<?php esc_attr_e( 'e.g. {stem}', 'plugnest-media-folders' ); ?>"></label>
								<label><?php esc_html_e( 'Alt text', 'plugnest-media-folders' ); ?> <input type="text" id="pnmf-edit-alt" placeholder="<?php esc_attr_e( 'e.g. {stem}', 'plugnest-media-folders' ); ?>"></label>
								<label><?php esc_html_e( 'Caption', 'plugnest-media-folders' ); ?> <input type="text" id="pnmf-edit-caption"></label>
								<label><?php esc_html_e( 'Description', 'plugnest-media-folders' ); ?> <input type="text" id="pnmf-edit-desc"></label>
							</div>
							<div class="pnmf-bulkbar-row">
								<div class="pnmf-field">
									<label><?php esc_html_e( 'Apply mode', 'plugnest-media-folders' ); ?></label>
									<select id="pnmf-edit-mode">
										<option value="replace"><?php esc_html_e( 'Replace original value', 'plugnest-media-folders' ); ?></option>
										<option value="append"><?php esc_html_e( 'Append after original', 'plugnest-media-folders' ); ?></option>
										<option value="prepend"><?php esc_html_e( 'Prepend before original', 'plugnest-media-folders' ); ?></option>
									</select>
								</div>
								<button type="button" class="button button-primary" data-bulk="bulk-edit"><?php esc_html_e( 'Apply fields', 'plugnest-media-folders' ); ?></button>
							</div>
						</div>
					</div>

					<div class="pnmf-folders" id="pnmf-folders" hidden></div>
					<div class="pnmf-grid" id="pnmf-grid"></div>
					<div class="pnmf-pagination" id="pnmf-pagination"></div>
				</section>

				<!-- ============ 右：詳細資料 ============ -->
				<aside class="pnmf-panel pnmf-inspector" id="pnmf-inspector">
					<div class="pnmf-inspector-empty" id="pnmf-inspector-empty">
						<span class="dashicons dashicons-format-image"></span>
						<p><?php esc_html_e( 'Click any media to edit its details here', 'plugnest-media-folders' ); ?></p>
					</div>
					<div class="pnmf-inspector-body" id="pnmf-inspector-body" hidden></div>
				</aside>

			</div>
		</div>

		<!-- ============ 自動分類對話框 ============ -->
		<div class="pnmf-modal" id="pnmf-modal-auto" hidden>
			<div class="pnmf-modal-box pnmf-modal-box--wide">
				<div class="pnmf-modal-head">
					<h2><?php esc_html_e( 'Auto-assign', 'plugnest-media-folders' ); ?></h2>
					<button type="button" class="pnmf-modal-close" data-close>×</button>
				</div>
				<div class="pnmf-modal-body">

					<div class="pnmf-notice">
						<?php esc_html_e( 'Rules are evaluated top-down; the first matching rule wins.', 'plugnest-media-folders' ); ?>
						<?php esc_html_e( 'Run "Dry run" to preview the result before applying.', 'plugnest-media-folders' ); ?>
					</div>

					<div class="pnmf-scope">
						<strong><?php esc_html_e( 'Scope:', 'plugnest-media-folders' ); ?></strong>
						<label class="pnmf-check"><input type="radio" name="pnmf-auto-scope" value="all" checked> <?php esc_html_e( 'All media', 'plugnest-media-folders' ); ?></label>
						<label class="pnmf-check"><input type="radio" name="pnmf-auto-scope" value="unassigned"> <?php esc_html_e( 'Unassigned only', 'plugnest-media-folders' ); ?></label>
						<label class="pnmf-check"><input type="radio" name="pnmf-auto-scope" value="image"> <?php esc_html_e( 'Images only', 'plugnest-media-folders' ); ?></label>
						<label class="pnmf-check"><input type="radio" name="pnmf-auto-scope" value="audio"> <?php esc_html_e( 'Audio only', 'plugnest-media-folders' ); ?></label>
						<label class="pnmf-check"><input type="radio" name="pnmf-auto-scope" value="video"> <?php esc_html_e( 'Videos only', 'plugnest-media-folders' ); ?></label>
					</div>

					<div id="pnmf-rules"></div>

					<div class="pnmf-rules-actions">
						<button type="button" class="button" id="pnmf-add-rule">＋ <?php esc_html_e( 'New rule', 'plugnest-media-folders' ); ?></button>
						<button type="button" class="button" id="pnmf-save-rules"><?php esc_html_e( 'Save rules', 'plugnest-media-folders' ); ?></button>
						<button type="button" class="button" id="pnmf-reset-rules"><?php esc_html_e( 'Restore default rules', 'plugnest-media-folders' ); ?></button>
					</div>

					<div class="pnmf-preview" id="pnmf-preview" hidden></div>
				</div>
				<div class="pnmf-modal-foot">
					<button type="button" class="button" id="pnmf-preview-btn"><?php esc_html_e( 'Dry run', 'plugnest-media-folders' ); ?></button>
					<button type="button" class="button button-primary" id="pnmf-apply-btn"><?php esc_html_e( 'Apply now', 'plugnest-media-folders' ); ?></button>
					<button type="button" class="button-link" data-close><?php esc_html_e( 'Close', 'plugnest-media-folders' ); ?></button>
				</div>
			</div>
		</div>

		<!-- ============ 操作記錄對話框 ============ -->
		<div class="pnmf-modal" id="pnmf-modal-logs" hidden>
			<div class="pnmf-modal-box">
				<div class="pnmf-modal-head">
					<h2><?php esc_html_e( 'Activity log', 'plugnest-media-folders' ); ?></h2>
					<button type="button" class="pnmf-modal-close" data-close>×</button>
				</div>
				<div class="pnmf-modal-body">
					<div class="pnmf-notice">
						<?php esc_html_e( 'Every batch action keeps a snapshot and can be undone with one click. Only classification and field changes are recorded — files are never touched.', 'plugnest-media-folders' ); ?>
					</div>
					<div id="pnmf-log-list"></div>
				</div>
			</div>
		</div>

		<!-- ============ Pro 購買引導 ============ -->
		<div class="pnmf-modal" id="pnmf-modal-upsell" hidden>
			<div class="pnmf-modal-box">
				<div class="pnmf-modal-head">
					<h2><?php esc_html_e( 'PlugNest Media Folders Pro', 'plugnest-media-folders' ); ?></h2>
					<button type="button" class="pnmf-modal-close" data-close>×</button>
				</div>
				<div class="pnmf-modal-body">
					<p><?php esc_html_e( 'This feature is part of PlugNest Media Folders Pro:', 'plugnest-media-folders' ); ?></p>
					<ul id="pnmf-upsell-features" style="margin:8px 0 12px 18px;list-style:disc">
						<li><?php esc_html_e( 'Unused-media cleanup wizard', 'plugnest-media-folders' ); ?></li>
						<li><?php esc_html_e( 'Missing-alt batch workflow', 'plugnest-media-folders' ); ?></li>
						<li><?php esc_html_e( 'Folder import/export & import from other folder plugins', 'plugnest-media-folders' ); ?></li>
						<li><?php esc_html_e( 'Folder access roles', 'plugnest-media-folders' ); ?></li>
						<li><?php esc_html_e( 'Delete folder together with its files (typed confirmation)', 'plugnest-media-folders' ); ?></li>
					</ul>
					<p><?php esc_html_e( 'Annual license, activate instantly with the key we email you.', 'plugnest-media-folders' ); ?></p>
				</div>
				<div class="pnmf-modal-foot">
					<a class="button button-primary" id="pnmf-upsell-buy" href="https://media-folders.plugnest.dev/" target="_blank" rel="noopener"><?php esc_html_e( 'Buy PlugNest Media Folders Pro', 'plugnest-media-folders' ); ?></a>
					<button type="button" class="button-link" data-close><?php esc_html_e( 'Close', 'plugnest-media-folders' ); ?></button>
				</div>
			</div>
		</div>

		<!-- ============ 進度遮罩 ============ -->
		<div class="pnmf-progress" id="pnmf-progress" hidden>
			<div class="pnmf-progress-box">
				<div class="pnmf-spinner"></div>
				<p id="pnmf-progress-text"><?php esc_html_e( 'Processing…', 'plugnest-media-folders' ); ?></p>
				<div class="pnmf-progress-bar"><span id="pnmf-progress-fill"></span></div>
				<button type="button" class="button" id="pnmf-progress-cancel" hidden><?php esc_html_e( 'Cancel', 'plugnest-media-folders' ); ?></button>
			</div>
		</div>

		<div class="pnmf-toast" id="pnmf-toast" hidden></div>
		<?php
	}
}
