$(document).ready(function(){
    $('#acquisition').on('change', function () {
        $('#version').html('');
    
        if ($('#acquisition').val() == "j0251"){
            $('#version').removeAttr('disabled');
            // $('#version').append('<option value="rag_flat_Jan2019_v2">rag_flat_Jan2019_v2</option>');
            $('#version').append('<option value="rag_flat_Jan2019_v3">j0251_rag_flat_Jan2019_v3</option>');
            $('#version').append('<option value="72_seg_20210127_agglo2">j0251_72_seg_20210127_agglo2</option>');
    
        } else if ($('#acquisition').val() == "j0126") {
            $('#version').removeAttr('disabled');
            $('#version').append('<option value="areaxfs_v10">j0126_areaxfs_v10</option>');
            $('#version').append('<option value="assembled_core_relabeled">j0126_assembled_core_relabeled</option>');

        // } else if ($('#acquisition').val() == "example_cube") {
        //     $('#version').removeAttr('disabled');
        //     $('#version').append('<option value="">1</option>');
        //     $('#version').append('<option value="">2</option>');
        //     $('#version').append('<option value="">3</option>');
            
        } else {
            $('#version').removeAttr('disabled');
            $('#version').append('<option value="">Select a dataset first</option>');
        }
    
        if ($('#version').val()) {
            $('#submit').removeAttr('disabled');
        } else {
            $('#submit').attr('disabled', 'disabled');
        }
    });

    $('#submit').on('click', function () {
        var $this = $(this);
        $this.addClass('buttonload');
        $('i').addClass('fa fa-refresh fa-spin');
        $this.text('Loading...');
    });
});