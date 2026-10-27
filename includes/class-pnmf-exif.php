<?php
/**
 * PlugNest Media Folders — EXIF 自動填補。
 *
 * 圖片上傳後，若標題／說明還是空的（或標題仍是檔名），從 EXIF 的
 * ImageDescription 自動帶入——不覆蓋任何已填寫的內容。
 *
 * 掛在 wp_generate_attachment_metadata（核心產生縮圖後必經之路），
 * 所以頁內上傳、媒體庫上傳、手機 App、REST 匯入全部一視同仁。
 * 沒有 exif 延伸套件或讀不到 EXIF 時靜默跳過，绝不報錯。
 *
 * @package PlugNest Media Folders
 */

defined( 'ABSPATH' ) || exit;

class PNMF_Exif {

	/**
	 * 註冊鉤子。
	 */
	public static function init() {
		add_action( 'wp_generate_attachment_metadata', array( __CLASS__, 'fill' ), 20, 2 );
	}

	/**
	 * 嘗試從 EXIF 填補空的標題與說明。
	 *
	 * @param array $metadata 附件 metadata。
	 * @param int   $id       附件 ID。
	 * @return array 原 metadata（本函式不修改它）。
	 */
	public static function fill( $metadata, $id ) {
		$post = get_post( $id );

		if ( ! $post || 'attachment' !== $post->post_type || 0 !== strpos( (string) $post->post_mime_type, 'image/' ) ) {
			return $metadata;
		}
		if ( ! function_exists( 'exif_read_data' ) ) {
			return $metadata;
		}

		$file = get_attached_file( $id );
		if ( ! $file || ! is_readable( $file ) || is_dir( $file ) ) {
			return $metadata;
		}

		/* 兩個欄位都已有內容就不必讀檔。 */
		$title = trim( (string) $post->post_title );
		$desc  = trim( (string) $post->post_content );
		if ( '' !== $title && '' !== $desc ) {
			return $metadata;
		}

		/* phpcs:ignore WordPress.PHP.NoSilencedErrors -- EXIF 讀取失敗是常態不是錯誤。 */
		$exif = @exif_read_data( $file );
		if ( ! is_array( $exif ) ) {
			return $metadata;
		}

		$text = trim( (string) ( isset( $exif['ImageDescription'] ) ? $exif['ImageDescription'] : '' ) );
		if ( '' === $text ) {
			return $metadata;
		}

		/* 部分手機把描述寫成 UTF-16（每字元夾 \x00）——能還原就還原。 */
		if ( preg_match( '/^\x00|[\x00]\x00/', $text ) || false !== strpos( $text, "\x00" ) ) {
			$converted = @iconv( 'UTF-16LE', 'UTF-8', $text ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
			if ( is_string( $converted ) && '' !== trim( $converted ) ) {
				$text = $converted;
			} else {
				$text = str_replace( "\x00", '', $text );
			}
		}

		$text = sanitize_text_field( $text );
		if ( '' === $text ) {
			return $metadata;
		}

		$update = array( 'ID' => (int) $id );

		/* 標題：空、或仍是檔名（核心預設行為）才帶入。 */
		if ( '' === $title ) {
			$update['post_title'] = function_exists( 'mb_substr' ) ? mb_substr( $text, 0, 100, 'UTF-8' ) : substr( $text, 0, 100 );
		} else {
			$stem = pathinfo( (string) get_post_meta( $id, '_wp_attached_file', true ), PATHINFO_FILENAME );
			if ( '' !== $stem && $title === $stem ) {
				$update['post_title'] = function_exists( 'mb_substr' ) ? mb_substr( $text, 0, 100, 'UTF-8' ) : substr( $text, 0, 100 );
			}
		}

		/* 說明：只在空白時帶入。 */
		if ( '' === $desc ) {
			$update['post_content'] = $text;
		}

		if ( count( $update ) > 1 ) {
			wp_update_post( $update );
		}

		return $metadata;
	}
}
