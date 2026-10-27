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
	 * 圖標用外掛自帶的品牌圖（assets/icon-128.png）「網址」，不是 data URI：
	 *   - PNG 的 data URI 會被 esc_url() 清成空字串（wp_allowed_protocols 沒有 data:）
	 *     → <img src="">，圖示直接不見。
	 *   - SVG 的 data URI 雖然核心會特別處理（改成 background-image），但在選單裡
	 *     會被渲染成單色，品牌色全失。
	 * 直接給檔案網址最穩：核心輸出 <img>，尺寸由 assets/css/menu-icon.css 固定成 20×20。
	 */
	public function menu() {
		$icon = 'dashicons-images-alt2';
		$png  = PNMF_PATH . 'assets/icon-128.png';
		if ( is_readable( $png ) ) {
			$icon = PNMF_URL . 'assets/icon-128.png';
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
	/**
	 * 給 JS 用的翻譯對照表（msgid => 譯文）。
	 *
	 * WP 的 wp_set_script_translations 需要 .json 命名完全對上，實務上常常載不到；
	 * 這裡直接從已載入的 .mo 取字串，透過 wp_localize_script 傳給 JS，最可靠。
	 *
	 * @return array
	 */
	private function js_i18n_map() {
		$locale = function_exists( 'determine_locale' ) ? determine_locale() : get_locale();
		$file   = PNMF_PATH . 'languages/plugnest-media-folders-' . $locale . '.mo';

		if ( ! file_exists( $file ) ) {
			return array();
		}

		$keys_file = PNMF_PATH . 'includes/js-i18n-keys.php';
		if ( ! file_exists( $keys_file ) ) {
			return array();
		}

		$mo = new MO();
		if ( ! $mo->import_from_file( $file ) ) {
			return array();
		}

		$map  = array();
		$keys = include $keys_file;
		foreach ( (array) $keys as $key ) {
			if ( isset( $mo->entries[ $key ] ) && ! empty( $mo->entries[ $key ]->translations ) ) {
				$value = (string) $mo->entries[ $key ]->translations[0];
				if ( '' !== $value ) {
					$map[ $key ] = $value;
				}
			}
		}

		return $map;
	}

	/**
	 * 是否自動顯示「新增功能在哪裡」導覽（每人可用核取方塊關掉）。
	 *
	 * @return bool
	 */
	private function should_show_guide() {
		if ( ! current_user_can( 'upload_files' ) ) {
			return false;
		}
		return ! get_user_meta( get_current_user_id(), 'pnmf_guide_muted', true );
	}

	public function assets( $hook ) {
		/*
		 * 側欄圖示的尺寸修正：選單在每一個後台頁面都會顯示，
		 * 所以這段不能跟著 is_plugin_page() 一起 return。
		 */
		wp_enqueue_style( 'pnmf-menu-icon', PNMF_URL . 'assets/css/menu-icon.css', array(), PNMF_VERSION );

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
				'guide'       => $this->should_show_guide() ? 1 : 0,
				'i18n'        => $this->js_i18n_map(),
				'buyUrl'      => 'https://media-folders.plugnest.dev/',
				'proFeatures' => array(
					__( 'Unused-media cleanup wizard', 'plugnest-media-folders' ),
					__( 'Missing-alt batch workflow', 'plugnest-media-folders' ),
					__( 'One-click duplicate cleanup (keep largest or newest)', 'plugnest-media-folders' ),
					__( 'Folder import/export & import from other folder plugins', 'plugnest-media-folders' ),
					__( 'Folder access roles', 'plugnest-media-folders' ),
					__( 'Delete folder together with its files (typed confirmation)', 'plugnest-media-folders' ),
				),
				'roles'       => PNMF_Taxonomy::get_role_names(),
				'views'       => PNMF_Ajax::user_views(),
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
						<img class="pnmf-header-logo" src="<?php echo esc_url( PNMF_URL . 'assets/logo.png' ); ?>" alt="" width="36" height="36">
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
					<?php if ( defined( 'PNMFP_VERSION' ) ) : ?>
						<a class="button" id="pnmf-btn-ai" href="<?php echo esc_url( admin_url( 'options-general.php?page=pnmf-pro#pnmfp-ai' ) ); ?>" title="<?php esc_attr_e( 'Provider, API key and model used by the AI features', 'plugnest-media-folders' ); ?>">
							<span class="dashicons dashicons-admin-generic"></span> <?php esc_html_e( 'AI settings', 'plugnest-media-folders' ); ?>
						</a>
					<?php endif; ?>
					<button type="button" class="button" id="pnmf-btn-guide" title="<?php esc_attr_e( 'What is new in 3.0.0 / 2.0.0 and where to find it', 'plugnest-media-folders' ); ?>">
						<span class="dashicons dashicons-editor-help"></span> <?php esc_html_e( 'Feature guide', 'plugnest-media-folders' ); ?>
					</button>
					<button type="button" class="button" id="pnmf-btn-dupe">
						<span class="dashicons dashicons-clone"></span> <?php esc_html_e( 'Find duplicates', 'plugnest-media-folders' ); ?>
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
						<span>·</span>
						<button type="button" class="button-link pnmf-mini-link" id="pnmf-btn-fstats"><?php esc_html_e( 'Stats', 'plugnest-media-folders' ); ?></button>
					</div>
								<div class="pnmf-tree-search">
						<input type="search" id="pnmf-tree-search" placeholder="<?php esc_attr_e( 'Find folder…', 'plugnest-media-folders' ); ?>" title="<?php esc_attr_e( 'Jump to folder (Ctrl+K)', 'plugnest-media-folders' ); ?>">
						<div class="pnmf-tree-search-results" id="pnmf-tree-search-results" hidden></div>
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

						<button type="button" class="pnmf-view-btn" id="pnmf-sort-pin" title="<?php esc_attr_e( 'Pin this sort as the current folder\'s default (click again to remove)', 'plugnest-media-folders' ); ?>">
							<span class="dashicons dashicons-sticky"></span>
						</button>

						<div class="pnmf-views">
							<select id="pnmf-views" title="<?php esc_attr_e( 'Saved views', 'plugnest-media-folders' ); ?>">
								<option value=""><?php esc_html_e( 'Saved views…', 'plugnest-media-folders' ); ?></option>
							</select>
							<button type="button" class="pnmf-view-btn" id="pnmf-view-save" title="<?php esc_attr_e( 'Save current filters as a view', 'plugnest-media-folders' ); ?>">
								<span class="dashicons dashicons-plus-alt2"></span>
							</button>
							<button type="button" class="pnmf-view-btn" id="pnmf-view-del" title="<?php esc_attr_e( 'Delete this view', 'plugnest-media-folders' ); ?>">
								<span class="dashicons dashicons-trash"></span>
							</button>
						</div>

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

		<!-- ============ 資料夾統計面板 ============ -->
		<div class="pnmf-modal" id="pnmf-modal-fstats" hidden>
			<div class="pnmf-modal-box pnmf-modal-box--wide">
				<div class="pnmf-modal-head">
					<h2><?php esc_html_e( 'Folder stats', 'plugnest-media-folders' ); ?></h2>
					<button type="button" class="pnmf-modal-close" data-close>×</button>
				</div>
				<div class="pnmf-modal-body">
					<div class="pnmf-notice">
						<?php esc_html_e( 'Per-folder breakdown of media assigned directly to each folder. Sizes come from the file-size index — run "File size" indexing once for accurate numbers.', 'plugnest-media-folders' ); ?>
					</div>
					<div id="pnmf-fstats-list"><span class="pnmf-hint"><?php esc_html_e( 'Loading…', 'plugnest-media-folders' ); ?></span></div>
				</div>
			</div>
		</div>

		<!-- ============ 重複檔偵測對話框（偵測免費；清理在 Pro） ============ -->
		<div class="pnmf-modal" id="pnmf-modal-dupe" hidden>
			<div class="pnmf-modal-box pnmf-modal-box--wide">
				<div class="pnmf-modal-head">
					<h2><?php esc_html_e( 'Duplicate files', 'plugnest-media-folders' ); ?></h2>
					<button type="button" class="pnmf-modal-close" data-close>×</button>
				</div>
				<div class="pnmf-modal-body">
					<div class="pnmf-notice">
						<?php esc_html_e( 'Files with identical content are grouped together. This report never deletes anything — review each group and decide yourself.', 'plugnest-media-folders' ); ?>
					</div>
					<div id="pnmf-dupe-job" class="pnmf-job" hidden>
						<div class="pnmf-job-top">
							<strong id="pnmf-job-count">0 / 0</strong>
							<span id="pnmf-job-eta" class="pnmf-hint"></span>
						</div>
						<div class="pnmf-job-bar"><span id="pnmf-job-fill"></span></div>
						<div class="pnmf-job-current" id="pnmf-job-file"></div>
					</div>
					<div id="pnmf-dupe-banner" class="pnmf-dupe-banner" hidden></div>
					<div id="pnmf-dupe-result" class="pnmf-dupe-result" hidden></div>
					<div id="pnmf-dupe-list"><span class="pnmf-hint"><?php esc_html_e( 'Loading…', 'plugnest-media-folders' ); ?></span></div>
				</div>
				<div class="pnmf-modal-foot">
					<button type="button" class="button" id="pnmf-dupe-rebuild" title="<?php esc_attr_e( 'Re-hash every file (slow). Use this if you replaced files outside WordPress.', 'plugnest-media-folders' ); ?>"><?php esc_html_e( 'Re-scan hashes', 'plugnest-media-folders' ); ?></button>
					<button type="button" class="button" id="pnmf-hash-cancel" hidden><?php esc_html_e( 'Stop', 'plugnest-media-folders' ); ?></button>
					<span id="pnmf-dupe-free-hint" class="pnmf-dupe-free-hint">
						<?php esc_html_e( 'One-click cleanup (keep the largest or newest copy) is a', 'plugnest-media-folders' ); ?>
						<a href="https://media-folders.plugnest.dev/" target="_blank" rel="noopener"><?php esc_html_e( 'Pro feature', 'plugnest-media-folders' ); ?></a>
					</span>
					<span id="pnmf-dupe-pro-ctrl" class="pnmf-dupe-pro-ctrl" hidden>
						<label class="pnmf-check" title="<?php esc_attr_e( 'Tick every copy to be deleted. One copy per group is always kept — if you tick them all, the largest/newest one is kept automatically.', 'plugnest-media-folders' ); ?>"><input type="checkbox" id="pnmf-dupe-checkall"> <?php esc_html_e( 'Select all copies', 'plugnest-media-folders' ); ?></label>
						<span class="pnmf-hint" id="pnmf-dupe-selcount">0 / 0</span>
						<span class="pnmf-dupe-sep">|</span>
						<label class="pnmf-check"><input type="radio" name="pnmf-dupe-keep" value="largest" checked> <?php esc_html_e( 'Keep largest', 'plugnest-media-folders' ); ?></label>
						<label class="pnmf-check"><input type="radio" name="pnmf-dupe-keep" value="newest"> <?php esc_html_e( 'Keep newest', 'plugnest-media-folders' ); ?></label>
						<label class="pnmf-check" title="<?php esc_attr_e( 'By default, copies that are referenced by posts — or that have never been usage-scanned — are never deleted.', 'plugnest-media-folders' ); ?>"><input type="checkbox" id="pnmf-dupe-include-used"> <?php esc_html_e( 'Also delete copies in use / not yet scanned', 'plugnest-media-folders' ); ?></label>
						<label class="pnmf-check" title="<?php esc_attr_e( 'Before deleting, all references (posts, Elementor, featured images) are rewritten to the kept copy — no dead images.', 'plugnest-media-folders' ); ?>"><input type="checkbox" id="pnmf-dupe-rewrite" checked> <?php esc_html_e( 'Rewrite links to the kept copy (recommended)', 'plugnest-media-folders' ); ?></label>
						<button type="button" class="button" id="pnmf-dupe-cancel" hidden><?php esc_html_e( 'Stop', 'plugnest-media-folders' ); ?></button>
						<button type="button" class="button button-primary pnmf-danger-btn" id="pnmf-dupe-clean"><?php esc_html_e( 'Clean up duplicates', 'plugnest-media-folders' ); ?></button>
					</span>
					<button type="button" class="button-link" data-close><?php esc_html_e( 'Close', 'plugnest-media-folders' ); ?></button>
				</div>
			</div>
		</div>

		<!-- ============ 功能導覽（3.0.0 / 2.0.0 新增內容） ============ -->
		<div class="pnmf-modal" id="pnmf-modal-guide" hidden>
			<div class="pnmf-modal-box pnmf-modal-box--wide">
				<div class="pnmf-modal-head">
					<h2><?php esc_html_e( 'What is new — and where to find it', 'plugnest-media-folders' ); ?></h2>
					<button type="button" class="pnmf-modal-close" data-close>×</button>
				</div>
				<div class="pnmf-modal-body">
					<p class="pnmf-guide-intro"><?php esc_html_e( 'One minute. Each line tells you where the control sits on this screen.', 'plugnest-media-folders' ); ?></p>
					<div class="pnmf-guide-grid">
						<div class="pnmf-guide-col">
							<h3><span class="pnmf-guide-tier"><?php esc_html_e( 'Free', 'plugnest-media-folders' ); ?></span> <?php esc_html_e( '3.0.0 additions', 'plugnest-media-folders' ); ?></h3>
							<p class="pnmf-guide-note"><?php esc_html_e( 'Included in the free plugin — no licence needed.', 'plugnest-media-folders' ); ?></p>
							<ul class="pnmf-guide-list">
								<li>
									<strong><?php esc_html_e( 'Duplicate detection', 'plugnest-media-folders' ); ?> <code>Find duplicates</code></strong>
									<span><?php esc_html_e( 'Toolbar, top right. Groups identical files by content hash with thumbnails, sizes and usage badges. Read-only.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'Folder stats', 'plugnest-media-folders' ); ?> <code>Stats</code></strong>
									<span><?php esc_html_e( 'Bottom of the left folder panel. Media count, type breakdown and disk usage per folder, sortable by size.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'Per-folder default sort', 'plugnest-media-folders' ); ?></strong>
									<span><?php esc_html_e( 'Pin icon next to the “Sort” dropdown. Pins the current order to the selected folder; click again to remove.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'Saved views', 'plugnest-media-folders' ); ?> <code>views</code></strong>
									<span><?php esc_html_e( 'Dropdown on the filter row plus the save icon beside it. Store any filter combination as a one-click view.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'Quick folder search', 'plugnest-media-folders' ); ?> <code>Ctrl+K</code></strong>
									<span><?php esc_html_e( '“Find folder…” box on the left panel. Type to jump straight to a folder.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'EXIF auto-fill', 'plugnest-media-folders' ); ?></strong>
									<span><?php esc_html_e( 'No button — titles and descriptions are filled from EXIF on upload when the field is empty.', 'plugnest-media-folders' ); ?></span>
								</li>
							</ul>
						</div>
						<div class="pnmf-guide-col<?php echo PNMF_Plugin::is_pro() ? '' : ' is-locked'; ?>"<?php echo PNMF_Plugin::is_pro() ? '' : ' aria-disabled="true"'; ?>>
							<h3><span class="pnmf-guide-tier is-pro">Pro</span> <?php esc_html_e( '2.0.0 additions', 'plugnest-media-folders' ); ?></h3>
							<?php if ( PNMF_Plugin::is_pro() ) : ?>
								<p class="pnmf-guide-note"><?php esc_html_e( 'Pro add-on features — an active licence is required.', 'plugnest-media-folders' ); ?></p>
							<?php else : ?>
								<p class="pnmf-guide-note pnmf-guide-note--locked">
									<strong><?php esc_html_e( 'You have the free version only', 'plugnest-media-folders' ); ?></strong> —
									<?php esc_html_e( 'the locations below do not exist on this screen until the Pro add-on is installed and activated.', 'plugnest-media-folders' ); ?>
									<a href="https://media-folders.plugnest.dev/" target="_blank" rel="noopener"><?php esc_html_e( 'See Pro', 'plugnest-media-folders' ); ?></a>
								</p>
							<?php endif; ?>
							<ul class="pnmf-guide-list">
								<li>
									<strong><?php esc_html_e( 'Duplicate cleanup with checkboxes', 'plugnest-media-folders' ); ?> <code>Clean up duplicates</code></strong>
									<span><?php esc_html_e( '“Find duplicates” → tick the copies to delete → “Clean up duplicates”. One copy per group is always kept; runs in batches with a progress bar and a Stop button.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'Replace media file', 'plugnest-media-folders' ); ?> <code>Replace file</code></strong>
									<span><?php esc_html_e( 'Right-hand inspector when a single item is selected. Swaps the file but keeps the URL.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'ZIP download', 'plugnest-media-folders' ); ?></strong>
									<span><?php esc_html_e( 'Select media → bulk bar → “Download ZIP”.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'Activity log CSV', 'plugnest-media-folders' ); ?></strong>
									<span><?php esc_html_e( 'Toolbar → “Activity log” → “Export CSV”.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'Weekly report & scheduled re-run', 'plugnest-media-folders' ); ?></strong>
									<span><?php esc_html_e( 'Settings → PlugNest Media Folders Pro, below the licence table.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'Folder access roles', 'plugnest-media-folders' ); ?></strong>
									<span><?php esc_html_e( 'Folder row “⋯” menu → “Roles”.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'Import / export folders', 'plugnest-media-folders' ); ?></strong>
									<span><?php esc_html_e( 'Left panel header → “Export”, “Import”, “From plugins”.', 'plugnest-media-folders' ); ?></span>
								</li>
								<li>
									<strong><?php esc_html_e( 'AI alt / tags / folders', 'plugnest-media-folders' ); ?></strong>
									<span><?php esc_html_e( '“Missing alt” → “Fill with AI”; bulk bar → “AI tags” / “AI folders”. API key: “AI settings” in the toolbar.', 'plugnest-media-folders' ); ?></span>
								</li>
							</ul>
						</div>
					</div>
				</div>
				<div class="pnmf-modal-foot pnmf-guide-foot">
					<label class="pnmf-check"><input type="checkbox" id="pnmf-guide-mute" checked> <?php esc_html_e( 'Do not show this automatically next time', 'plugnest-media-folders' ); ?></label>
					<?php if ( defined( 'PNMFP_VERSION' ) ) : ?>
						<a class="button-link" id="pnmf-guide-more" href="<?php echo esc_url( admin_url( 'options-general.php?page=pnmf-pro#pnmfp-features' ) ); ?>"><?php esc_html_e( 'Full list in Settings', 'plugnest-media-folders' ); ?></a>
					<?php endif; ?>
					<button type="button" class="button button-primary" id="pnmf-guide-close"><?php esc_html_e( 'Got it', 'plugnest-media-folders' ); ?></button>
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
						<li><?php esc_html_e( 'One-click duplicate cleanup (keep largest or newest)', 'plugnest-media-folders' ); ?></li>
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
