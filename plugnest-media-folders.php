<?php
/**
 * Plugin Name:       PlugNest Media Folders
 * Plugin URI:        https://media-folders.plugnest.dev/
 * Description:       Media library management: virtual folders (hierarchical, role-restricted), tags, batch editing, usage scanning, unused cleanup, missing-alt workflow, folder import/export, in-page upload, and Elementor/Gutenberg media modal integration. Never touches file paths.
 * Version:           2.5.4
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            PlugNest
 * Author URI:        https://www.plugnest.dev/
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       plugnest-media-folders
 * Copyright:       © PlugNest — plugnest.dev
 */

defined( 'ABSPATH' ) || exit;

define( 'PNMF_VERSION', '2.5.4' );
define( 'PNMF_FILE', __FILE__ );
define( 'PNMF_PATH', plugin_dir_path( __FILE__ ) );
define( 'PNMF_URL', plugin_dir_url( __FILE__ ) );

/**
 * 載入翻譯檔（languages/）。字串皆以 gettext 包裝，繁中／簡中就緒。
 *
 * load_plugin_textdomain（6.7+ 只註冊路徑，交給 JIT）之外補一次
 * 絕對路徑的 load_textdomain：在物件快取殘留舊查找結果、或 JIT 對
 * 自訂路徑解析失效的環境裡，這條是確定性的載入路徑。
 */
add_action(
	'init',
	function () {
		load_plugin_textdomain( 'plugnest-media-folders', false, dirname( plugin_basename( __FILE__ ) ) . '/languages' );

		$locale = function_exists( 'determine_locale' ) ? determine_locale() : get_locale();
		if ( ! $locale || 'en_US' === $locale ) {
			return;
		}
		$mo = PNMF_PATH . 'languages/plugnest-media-folders-' . $locale . '.mo';
		if ( is_readable( $mo ) ) {
			load_textdomain( 'plugnest-media-folders', $mo );
		}
	}
);

/**
 * 分類法 slug。
 *
 * slug 曾於 2.5.1 從 mn_media_* 改為 pnmf_media_*（wp.org 前綴規範），
 * 舊站資料由 PNMF_Migrate 原地改名遷移；此後不要再動。
 */
define( 'PNMF_TAX_FOLDER', 'pnmf_media_folder' );
define( 'PNMF_TAX_TAG', 'pnmf_media_tag' );

/** 操作記錄資料表（不含 wpdb 前綴）。 */
define( 'PNMF_TBL_LOG', 'pnmf_media_log' );

/** 使用狀態快取的 postmeta key（值為 1/0）。 */
define( 'PNMF_META_USAGE', '_pnmf_usage' );
define( 'PNMF_META_USAGE_AT', '_pnmf_usage_at' );

require_once PNMF_PATH . 'includes/class-pnmf-taxonomy.php';
require_once PNMF_PATH . 'includes/class-pnmf-log.php';
require_once PNMF_PATH . 'includes/class-pnmf-usage.php';
require_once PNMF_PATH . 'includes/class-pnmf-query.php';
require_once PNMF_PATH . 'includes/class-pnmf-auto.php';
require_once PNMF_PATH . 'includes/class-pnmf-ajax.php';
require_once PNMF_PATH . 'includes/class-pnmf-native.php';
require_once PNMF_PATH . 'includes/class-pnmf-upload.php';
require_once PNMF_PATH . 'includes/class-pnmf-modal.php';
require_once PNMF_PATH . 'includes/class-pnmf-admin.php';
require_once PNMF_PATH . 'includes/class-pnmf-plugin.php';
require_once PNMF_PATH . 'includes/class-pnmf-migrate.php';

PNMF_Plugin::instance();
PNMF_Modal::instance();

register_activation_hook( __FILE__, array( 'PNMF_Plugin', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'PNMF_Plugin', 'deactivate' ) );
